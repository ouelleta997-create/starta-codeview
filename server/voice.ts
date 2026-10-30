import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, getSettings } from "./store.ts";

// Dictée vocale : CodeView lance un petit serveur FastAPI local (voice/server.py, Whisper en local)
// et lui transmet les enregistrements. Rien ne sort de la machine.
// Installation : « npm run voice:install » (crée l'environnement Python dans ~/.starta-codeview).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "voice", "server.py");
export const VOICE_VENV = path.join(DATA_DIR, "voice-venv");
export const VOICE_MODELS = path.join(DATA_DIR, "voice-models");
const venvPython = () => path.join(VOICE_VENV, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

/** Sidecar géré par un autre processus (développement) : CODEVIEW_VOICE_URL + CODEVIEW_VOICE_TOKEN. */
const EXTERNAL = (process.env.CODEVIEW_VOICE_URL ?? "").replace(/\/+$/, "");
const token = process.env.CODEVIEW_VOICE_TOKEN || crypto.randomBytes(16).toString("hex");

export type VoiceState = "off" | "loading" | "ready" | "error";
export interface VoiceSummary {
  installed: boolean;
  state: VoiceState;
  model: string;
  device: string;
  error: string;
}

let child: ChildProcess | null = null;
let baseUrl = EXTERNAL;
let startedModel = "";
let launching: Promise<void> | null = null;
let health: { status: string; error: string; device: string } = { status: "loading", error: "", device: "" };
let lastError = "";
const stderrTail: string[] = [];

export const voiceInstalled = () => !!EXTERNAL || (fs.existsSync(venvPython()) && fs.existsSync(SCRIPT));

export function voiceSummary(): VoiceSummary {
  const installed = voiceInstalled();
  const model = getSettings().voiceModel;
  if (!installed) return { installed, state: "off", model, device: "", error: "" };
  if (lastError && !child && !EXTERNAL) return { installed, state: "error", model, device: "", error: lastError };
  if (!baseUrl) return { installed, state: "off", model, device: "", error: "" };
  const state: VoiceState = health.status === "ready" ? "ready" : health.status === "error" ? "error" : "loading";
  return { installed, state, model: EXTERNAL ? "externe" : startedModel || model, device: health.device, error: health.error };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const sidecarFetch = (route: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${route}`, { ...init, headers: { "X-Voice-Token": token, ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(120_000) });

/** Interroge le moteur et met à jour l'état connu. */
export async function refreshVoice(): Promise<VoiceSummary> {
  if (baseUrl) {
    try {
      const r = await sidecarFetch("/health", { signal: AbortSignal.timeout(2000) });
      if (r.ok) health = (await r.json()) as typeof health;
    } catch {
      /* démarrage en cours ou arrêté */
    }
  }
  return voiceSummary();
}

export async function startVoice(): Promise<void> {
  if (EXTERNAL || !voiceInstalled()) return;
  const model = getSettings().voiceModel;
  if (child && startedModel === model) return;
  if (launching) return launching;
  launching = (async () => {
    stopVoice();
    lastError = "";
    stderrTail.length = 0;
    const port = await freePort();
    startedModel = model;
    health = { status: "loading", error: "", device: "" };
    const p = spawn(venvPython(), [SCRIPT, "--port", String(port)], {
      env: {
        ...process.env,
        CODEVIEW_VOICE_TOKEN: token,
        CODEVIEW_VOICE_MODEL: model,
        CODEVIEW_VOICE_MODELS: VOICE_MODELS,
        CODEVIEW_VOICE_WATCH_PARENT: "1",
        PYTHONUTF8: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
      },
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    child = p;
    baseUrl = `http://127.0.0.1:${port}`;
    p.stderr?.on("data", (d) => {
      stderrTail.push(...String(d).split(/\r?\n/).filter(Boolean));
      stderrTail.splice(0, Math.max(0, stderrTail.length - 12));
    });
    p.on("error", (e) => {
      lastError = `Impossible de lancer Python : ${e.message}`;
    });
    p.on("exit", (code) => {
      if (child === p) {
        child = null;
        baseUrl = "";
        if (code) lastError = `Le moteur vocal s'est arrêté (code ${code}). ${stderrTail.slice(-3).join(" ")}`.trim();
      }
    });
    // On suit le chargement en fond (téléchargement du modèle au tout premier lancement).
    void (async () => {
      for (let i = 0; i < 1800 && child === p; i++) {
        const s = await refreshVoice();
        if (s.state === "ready" || s.state === "error") return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
  })().finally(() => {
    launching = null;
  });
  return launching;
}

export function stopVoice() {
  const p = child;
  child = null;
  baseUrl = EXTERNAL;
  startedModel = "";
  if (p && !p.killed) p.kill();
}

export async function restartVoice() {
  stopVoice();
  await startVoice();
}

export class VoiceError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

/** Envoie un enregistrement au moteur et renvoie le texte. Attend le chargement du modèle au besoin. */
export async function transcribe(audio: Buffer, lang: string): Promise<{ text: string; language: string; seconds: number; ms: number }> {
  if (!voiceInstalled()) throw new VoiceError("La voix n'est pas installée — lance « npm run voice:install » (ou Installer-voix.bat).", 503);
  await startVoice();
  const deadline = Date.now() + 120_000;
  for (;;) {
    const s = await refreshVoice();
    if (s.state === "ready") break;
    if (s.state === "error") throw new VoiceError(`Moteur vocal en erreur : ${s.error || lastError}`, 500);
    if (!baseUrl && !child) throw new VoiceError(lastError || "Le moteur vocal ne démarre pas.", 500);
    if (Date.now() > deadline) throw new VoiceError("Le modèle vocal se charge encore (premier lancement : téléchargement) — réessaie dans une minute.", 503);
    await new Promise((r) => setTimeout(r, 500));
  }
  const r = await sidecarFetch(`/transcribe?lang=${encodeURIComponent(lang || "fr")}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: new Uint8Array(audio) });
  if (!r.ok) {
    let detail = "";
    try {
      detail = ((await r.json()) as { detail?: string }).detail ?? "";
    } catch {
      /* corps illisible */
    }
    throw new VoiceError(detail || `Moteur vocal : erreur ${r.status}`, r.status === 503 ? 503 : 502);
  }
  return (await r.json()) as { text: string; language: string; seconds: number; ms: number };
}

process.on("exit", () => child?.kill());
