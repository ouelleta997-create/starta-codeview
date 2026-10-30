import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DATA_DIR, PROVIDER_IDS, getSettings, patchSettings, rememberWorkspace, setSecret, getSecret, deleteSecret, maskSecret, sessionToken,
  listChats, loadChat, saveChat, deleteChat, newChat, type ProviderId, type SecretName,
} from "./store.ts";
import { PROVIDERS, baseUrl, listModels } from "./providers.ts";
import * as n8n from "./n8n.ts";
import { runAgent, resolveApproval, type AgentEvent } from "./agent.ts";
import { runCommand, SHELL_NAME } from "./shell.ts";
import { IGNORED_DIRS, iterFiles, insideWorkspace } from "./tools.ts";
import { VoiceError, refreshVoice, restartVoice, startVoice, transcribe, voiceSummary } from "./voice.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(HERE, "..", "web", "dist");
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version as string;
const TOKEN = sessionToken();
const args = process.argv.slice(2);
const START_PORT = Number(process.env.PORT) || 5757;

// ───────────────────────── Utilitaires HTTP ─────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".map": "application/json",
};

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isStr = typeof body === "string";
  res.writeHead(status, { "Content-Type": isStr ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

async function readRaw(req: http.IncomingMessage, limit = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw httpError(413, "Requête trop volumineuse");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: http.IncomingMessage, limit = 25 * 1024 * 1024): Promise<any> {
  const t = (await readRaw(req, limit)).toString("utf8");
  return t ? JSON.parse(t) : {};
}

function cookieToken(req: http.IncomingMessage): string | null {
  const m = /(?:^|;\s*)cv_token=([a-f0-9]+)/.exec(req.headers.cookie ?? "");
  return m ? m[1] : null;
}

function hostOk(req: http.IncomingMessage): boolean {
  const h = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function originOk(req: http.IncomingMessage): boolean {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return new URL(o).host === req.headers.host;
  } catch {
    return false;
  }
}

const authed = (req: http.IncomingMessage) => cookieToken(req) === TOKEN;

// ───────────────────────── Espace de travail ─────────────────────────

const ws = () => getSettings().workspace;

function inWs(rel: string): string {
  const root = ws();
  if (!root) throw httpError(400, "Aucun dossier ouvert.");
  const abs = path.resolve(root, rel || ".");
  if (!insideWorkspace(root, abs)) throw httpError(403, "Chemin hors de l'espace de travail.");
  return abs;
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const clients = new Set<WebSocket>();
function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

let watcher: fs.FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;
const dirtyPaths = new Set<string>();
function startWatcher() {
  watcher?.close();
  watcher = null;
  const root = ws();
  if (!root || !fs.existsSync(root)) return;
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const parts = name.split(/[\\/]/);
      if (parts.some((p) => IGNORED_DIRS.has(p) || p === ".git")) return;
      dirtyPaths.add(parts.join("/"));
      watchTimer ??= setTimeout(() => {
        watchTimer = null;
        broadcast({ type: "fs.changed", paths: [...dirtyPaths].slice(0, 200) });
        dirtyPaths.clear();
      }, 250);
    });
    watcher.on("error", () => {});
  } catch {
    /* surveillance indisponible : l'interface se rafraîchit à la main */
  }
}

async function pickFolder(): Promise<string | null> {
  if (process.platform === "win32") {
    const script = `Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.Form; $f.TopMost=$true; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Ouvrir un dossier dans Starta CodeView'; if($d.ShowDialog($f) -eq 'OK'){[Console]::OutputEncoding=[Text.Encoding]::UTF8; $d.SelectedPath}`;
    const r = await new Promise<string>((resolve) => {
      const p = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: true });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", () => resolve(out.trim()));
      p.on("error", () => resolve(""));
    });
    return r || null;
  }
  if (process.platform === "darwin") {
    const r = await runCommand({ command: `osascript -e 'POSIX path of (choose folder)'`, cwd: os.homedir(), timeoutMs: 300000 });
    return r.code === 0 ? r.output.trim() : null;
  }
  const r = await runCommand({ command: "zenity --file-selection --directory", cwd: os.homedir(), timeoutMs: 300000 });
  return r.code === 0 ? r.output.trim() : null;
}

// ───────────────────────── API ─────────────────────────

const modelCache = new Map<string, { at: number; value: unknown }>();

function publicState() {
  const s = getSettings();
  const providers: Record<string, unknown> = {};
  for (const id of PROVIDER_IDS) {
    const key = getSecret(id);
    providers[id] = { label: PROVIDERS[id].label, configured: !!key, masked: maskSecret(key), baseUrl: baseUrl(id), defaultBaseUrl: PROVIDERS[id].baseUrl, presets: PROVIDERS[id].presets ?? [] };
  }
  const nk = getSecret("n8n");
  return {
    version: VERSION,
    settings: s,
    providers,
    n8n: { url: s.n8nUrl, configured: !!(s.n8nUrl && nk), masked: maskSecret(nk) },
    voice: voiceSummary(),
    platform: process.platform,
    shell: SHELL_NAME,
    home: os.homedir(),
    dataDir: DATA_DIR,
  };
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const p = url.pathname;
  const m = req.method ?? "GET";

  // Dictée : le corps est de l'audio brut, pas du JSON.
  if (p === "/api/voice/transcribe" && m === "POST") {
    try {
      const audio = await readRaw(req);
      return send(res, 200, await transcribe(audio, url.searchParams.get("lang") || getSettings().voiceLang));
    } catch (e) {
      if (e instanceof VoiceError) throw httpError(e.status, e.message);
      throw e;
    }
  }

  const body = m === "GET" || m === "DELETE" ? {} : await readBody(req);
  let g: RegExpMatchArray | null;

  if (p === "/api/state" && m === "GET") return send(res, 200, publicState());
  if (p === "/api/voice/status" && m === "GET") return send(res, 200, await refreshVoice());

  if (p === "/api/settings" && m === "PUT") {
    const allowed = ["approval", "theme", "model", "baseUrls", "n8nUrl", "voiceModel", "voiceLang", "voiceAutoSend"] as const;
    const patch: Record<string, unknown> = {};
    for (const k of allowed) if (k in body) patch[k] = body[k];
    const modelBefore = getSettings().voiceModel;
    patchSettings(patch);
    if (getSettings().voiceModel !== modelBefore) void restartVoice();
    modelCache.clear();
    return send(res, 200, publicState());
  }

  if ((g = p.match(/^\/api\/secrets\/(zai|mistral|anthropic|openrouter|n8n)$/))) {
    const name = g[1] as SecretName;
    if (m === "PUT") {
      if (typeof body.value !== "string" || !body.value.trim()) throw httpError(400, "Valeur vide.");
      setSecret(name, body.value.trim());
      modelCache.clear();
    } else if (m === "DELETE") {
      deleteSecret(name);
      modelCache.clear();
    }
    return send(res, 200, publicState());
  }

  if (p === "/api/models" && m === "GET") {
    const out: Record<string, unknown> = {};
    await Promise.all(
      PROVIDER_IDS.filter((id) => getSecret(id)).map(async (id) => {
        const c = modelCache.get(id);
        if (c && Date.now() - c.at < 5 * 60_000) return void (out[id] = c.value);
        let value: unknown;
        try {
          value = { live: true, models: await listModels(id) };
        } catch (e) {
          value = { live: false, error: (e as Error).message, models: PROVIDERS[id].fallbackModels.map((x) => ({ id: x })) };
        }
        modelCache.set(id, { at: Date.now(), value });
        out[id] = value;
      }),
    );
    return send(res, 200, out);
  }

  if ((g = p.match(/^\/api\/test\/(zai|mistral|anthropic|openrouter|n8n)$/)) && m === "POST") {
    try {
      if (g[1] === "n8n") {
        const w = await n8n.listWorkflows();
        return send(res, 200, { ok: true, message: `Connecté — ${w.length} workflow${w.length > 1 ? "s" : ""}.` });
      }
      const models = await listModels(g[1] as ProviderId);
      return send(res, 200, { ok: true, message: `Clé valide — ${models.length} modèles.` });
    } catch (e) {
      return send(res, 200, { ok: false, message: (e as Error).message });
    }
  }

  // ── Dossier de travail ──
  if (p === "/api/workspace/pick" && m === "POST") return send(res, 200, { path: await pickFolder() });
  if (p === "/api/workspace" && m === "POST") {
    const dir = path.resolve(String(body.path ?? ""));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, `Dossier introuvable : ${dir}`);
    rememberWorkspace(dir);
    startWatcher();
    return send(res, 200, publicState());
  }

  // ── Fichiers ──
  if (p === "/api/fs/dir" && m === "GET") {
    const abs = inWs(url.searchParams.get("path") ?? "");
    const rel = (url.searchParams.get("path") ?? "").replace(/\\/g, "/").replace(/^\/|\/$/g, "");
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.name !== ".git" && (e.isDirectory() || e.isFile() || e.isSymbolicLink()))
      .map((e) => ({ name: e.name, dir: e.isDirectory(), path: rel ? `${rel}/${e.name}` : e.name, ignored: e.isDirectory() && IGNORED_DIRS.has(e.name) }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return send(res, 200, { entries });
  }
  if (p === "/api/fs/files" && m === "GET") {
    const root = ws();
    if (!root) throw httpError(400, "Aucun dossier ouvert.");
    return send(res, 200, { files: [...iterFiles(root, 15000)] });
  }
  if (p === "/api/fs/file" && m === "GET") {
    const abs = inWs(url.searchParams.get("path") ?? "");
    const st = fs.statSync(abs);
    if (st.size > 3 * 1024 * 1024) return send(res, 200, { tooLarge: true, size: st.size });
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 4096).includes(0)) return send(res, 200, { binary: true, size: st.size });
    return send(res, 200, { content: buf.toString("utf8"), mtime: st.mtimeMs, size: st.size });
  }
  if (p === "/api/fs/file" && m === "PUT") {
    const abs = inWs(String(body.path));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(body.content ?? ""));
    return send(res, 200, { mtime: fs.statSync(abs).mtimeMs });
  }
  if (p === "/api/fs/create" && m === "POST") {
    const abs = inWs(String(body.path));
    if (fs.existsSync(abs)) throw httpError(409, "Existe déjà.");
    if (body.dir) fs.mkdirSync(abs, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "");
    }
    return send(res, 200, { ok: true });
  }
  if (p === "/api/fs/rename" && m === "POST") {
    const from = inWs(String(body.from));
    const to = inWs(String(body.to));
    if (fs.existsSync(to)) throw httpError(409, "La destination existe déjà.");
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return send(res, 200, { ok: true });
  }
  if (p === "/api/fs/delete" && m === "POST") {
    const abs = inWs(String(body.path));
    if (abs === ws()) throw httpError(403, "Impossible de supprimer la racine.");
    fs.rmSync(abs, { recursive: true, force: true });
    return send(res, 200, { ok: true });
  }

  // ── n8n ──
  if (p === "/api/n8n/workflows" && m === "GET") return send(res, 200, await n8n.listWorkflows());
  if ((g = p.match(/^\/api\/n8n\/workflows\/([^/]+)$/))) {
    if (m === "GET") return send(res, 200, await n8n.getWorkflow(g[1]));
    if (m === "PUT") return send(res, 200, await n8n.updateWorkflow(g[1], body));
  }
  if ((g = p.match(/^\/api\/n8n\/workflows\/([^/]+)\/(activate|deactivate)$/)) && m === "POST") return send(res, 200, await n8n.setActive(g[1], g[2] === "activate"));

  // ── Conversations ──
  if (p === "/api/chats" && m === "GET") return send(res, 200, listChats());
  if ((g = p.match(/^\/api\/chats\/([\w-]+)$/))) {
    if (m === "GET") {
      const c = loadChat(g[1]);
      return c ? send(res, 200, c) : send(res, 404, { error: "Conversation introuvable." });
    }
    if (m === "DELETE") {
      deleteChat(g[1]);
      return send(res, 200, { ok: true });
    }
  }

  send(res, 404, { error: "Route inconnue." });
}

// ───────────────────────── Serveur HTTP ─────────────────────────

const LOCKED = `<!doctype html><meta charset="utf-8"><title>Starta CodeView</title><body style="font:15px system-ui;background:#161616;color:#ddd;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:30rem;line-height:1.5"><h2 style="margin:0 0 .5rem">Starta CodeView</h2><p>Cette page exige le jeton local. Lance l'application avec <code>npm start</code> (la fenêtre s'ouvre toute seule) ou ouvre l'adresse complète affichée dans la console.</p></div>`;

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return send(res, 403, "Hôte refusé.");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/ping") return send(res, 200, { app: "starta-codeview", version: VERSION });

    // Premier accès : le jeton dans l'URL devient un cookie, puis disparaît de la barre d'adresse.
    const t = url.searchParams.get("t");
    if (t && t === TOKEN) {
      url.searchParams.delete("t");
      res.writeHead(302, { Location: url.pathname + url.search, "Set-Cookie": `cv_token=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
      return void res.end();
    }

    if (url.pathname.startsWith("/api/")) {
      if (!authed(req)) return send(res, 401, { error: "Non autorisé." });
      if (req.method !== "GET" && !originOk(req)) return send(res, 403, { error: "Origine refusée." });
      try {
        await api(req, res, url);
      } catch (e) {
        const status = (e as { status?: number }).status ?? ((e as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500);
        send(res, status, { error: (e as Error).message });
      }
      return;
    }

    if (!authed(req)) return send(res, 401, LOCKED, { "Content-Type": "text/html; charset=utf-8" });
    if (!fs.existsSync(WEB_DIST)) return send(res, 503, "Interface non compilée — lance « npm run build » (ou « npm run dev »).");
    let file = path.join(WEB_DIST, decodeURIComponent(url.pathname));
    if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, "index.html");
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 500, (e as Error).message);
  }
});

// ───────────────────────── WebSocket ─────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!hostOk(req) || !originOk(req) || !req.headers.origin || !authed(req) || !req.url?.startsWith("/ws")) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return void socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (sock) => wss.emit("connection", sock));
});

wss.on("connection", (sock: WebSocket) => {
  clients.add(sock);
  const out = (m: unknown) => sock.readyState === 1 && sock.send(JSON.stringify(m));
  const runs = new Map<string, AbortController>();
  let termCwd: string | null = null;
  let termAbort: AbortController | null = null;

  sock.on("message", async (raw) => {
    let m: any;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (m.type) {
      case "chat": {
        const root = ws();
        let chat = (m.chatId && loadChat(m.chatId)) || newChat(root);
        if (m.chatId && !loadChat(m.chatId)) chat.id = String(m.chatId).replace(/[^\w-]/g, "");
        if (runs.has(chat.id)) return out({ type: "chat.event", chatId: chat.id, event: { type: "error", message: "Cette conversation travaille déjà." } });
        const ctl = new AbortController();
        runs.set(chat.id, ctl);
        const emit = (event: AgentEvent) => out({ type: "chat.event", chatId: chat.id, event });
        const model = m.model ?? getSettings().model;
        if (!model) {
          emit({ type: "error", message: "Choisis un modèle (en bas du panneau) — ajoute d'abord une clé dans Réglages." });
          emit({ type: "done", reason: "error" });
          runs.delete(chat.id);
          return;
        }
        patchSettings({ model });
        await runAgent({
          chat, text: String(m.text ?? ""), model, context: m.context, signal: ctl.signal, emit,
          onTerminal: (data) => out({ type: "term.data", source: "agent", data }),
          onFileChanged: (file) => out({ type: "fs.agent", path: path.relative(root ?? "", file).replace(/\\/g, "/") }),
        });
        runs.delete(chat.id);
        break;
      }
      case "stop":
        runs.get(m.chatId)?.abort();
        break;
      case "approve":
        resolveApproval(String(m.id), !!m.allow);
        break;
      case "term": {
        const root = ws();
        if (!root) return out({ type: "term.data", source: "user", data: "Aucun dossier ouvert.\r\n" });
        termCwd ??= root;
        const cmd = String(m.command ?? "");
        const cd = /^\s*(?:cd|set-location)\s+(.+?)\s*$/i.exec(cmd);
        if (cd) {
          const target = path.resolve(termCwd, cd[1].replace(/^["']|["']$/g, "").replace(/^~/, os.homedir()));
          if (fs.existsSync(target) && fs.statSync(target).isDirectory()) termCwd = target;
          else out({ type: "term.data", source: "user", data: `Dossier introuvable : ${target}\r\n` });
          return out({ type: "term.exit", code: 0, cwd: termCwd });
        }
        termAbort?.abort();
        termAbort = new AbortController();
        const r = await runCommand({ command: cmd, cwd: termCwd, timeoutMs: 30 * 60_000, signal: termAbort.signal, onData: (data) => out({ type: "term.data", source: "user", data }) });
        out({ type: "term.exit", code: r.code, cwd: termCwd });
        break;
      }
      case "term_kill":
        termAbort?.abort();
        break;
      case "term_cwd":
        termCwd = ws();
        out({ type: "term.exit", code: 0, cwd: termCwd });
        break;
    }
  });

  sock.on("close", () => {
    clients.delete(sock);
    for (const c of runs.values()) c.abort();
    termAbort?.abort();
  });
  out({ type: "hello", version: VERSION });
});

// ───────────────────────── Démarrage ─────────────────────────

function findBrowser(): string | null {
  const c: string[] = [];
  if (process.platform === "win32") {
    for (const base of [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
      if (!base) continue;
      c.push(path.join(base, "Microsoft/Edge/Application/msedge.exe"), path.join(base, "Google/Chrome/Application/chrome.exe"), path.join(base, "BraveSoftware/Brave-Browser/Application/brave.exe"));
    }
  } else if (process.platform === "darwin") {
    c.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    c.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge");
  }
  return c.find((f) => fs.existsSync(f)) ?? null;
}

function openWindow(url: string) {
  const exe = findBrowser();
  if (exe) {
    // Fenêtre d'application (sans barre d'onglets), profil à part : n'interfère pas avec ton navigateur.
    const profile = path.join(DATA_DIR, "browser-profile");
    spawn(exe, [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1560,980"], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
    return ((await r.json()) as { app?: string }).app === "starta-codeview";
  } catch {
    return false;
  }
}

function listen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" && port < START_PORT + 20 ? resolve(listen(port + 1)) : reject(e)));
    server.listen(port, "127.0.0.1", () => resolve(port));
  });
}

async function main() {
  if (!fs.existsSync(path.join(WEB_DIST, "index.html")) && fs.existsSync(path.join(HERE, "..", "web", "index.html"))) {
    console.log("Première exécution : compilation de l'interface…");
    const r = spawnSync("npm", ["run", "build"], { cwd: path.join(HERE, ".."), stdio: "inherit", shell: true });
    if (r.status !== 0) { console.error("La compilation a échoué — lance « npm install » puis « npm run build »."); process.exit(1); }
  }
  const noOpen = args.includes("--no-open") || process.env.CODEVIEW_NO_OPEN === "1";
  const page = args.find((a) => a.startsWith("--page="))?.slice(7) ?? ""; // ex. --page=settings/n8n
  if (await alreadyRunning(START_PORT)) {
    const url = `http://127.0.0.1:${START_PORT}/?t=${TOKEN}${page ? `#${page}` : ""}`;
    console.log(`Starta CodeView tourne déjà — ouverture d'une fenêtre : http://127.0.0.1:${START_PORT}/`);
    if (!noOpen) openWindow(url);
    return;
  }
  const port = await listen(START_PORT);
  startWatcher();
  void startVoice(); // charge Whisper en fond pour que le premier micro réponde tout de suite (sans effet si la voix n'est pas installée)
  const url = `http://127.0.0.1:${port}/?t=${TOKEN}${page ? `#${page}` : ""}`;
  console.log(`\n  Starta CodeView ${VERSION}\n  → ${url}\n  Données : ${DATA_DIR}\n  Ctrl+C pour arrêter.\n`);
  if (!noOpen) openWindow(url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

process.on("uncaughtException", (e) => console.error("[erreur]", e));
process.on("unhandledRejection", (e) => console.error("[rejet]", e));
