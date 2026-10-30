import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const DATA_DIR = process.env.CODEVIEW_HOME ?? path.join(os.homedir(), ".starta-codeview");
fs.mkdirSync(path.join(DATA_DIR, "chats"), { recursive: true });

// ───────────────────────── Réglages (non secrets) ─────────────────────────

/** Identifiant d'un fournisseur : voir le registre PROVIDERS dans providers.ts. */
export type ProviderId = string;

export interface Settings {
  workspace: string | null;
  recents: string[];
  approval: "auto" | "ask";
  theme: "dark" | "light" | "system";
  model: { provider: ProviderId; id: string } | null;
  baseUrls: Partial<Record<ProviderId, string>>;
  n8nUrl: string;
  /** Modèle Whisper du moteur vocal local (tiny, base, small, medium, large-v3-turbo…). */
  voiceModel: string;
  /** Langue parlée : code ISO (« fr », « en ») ou « auto ». */
  voiceLang: string;
  /** Envoyer le message à l'agent dès que la dictée est transcrite. */
  voiceAutoSend: boolean;
}

const DEFAULTS: Settings = {
  workspace: null,
  recents: [],
  approval: "auto",
  theme: "dark",
  model: null,
  baseUrls: {},
  n8nUrl: "",
  voiceModel: "small",
  voiceLang: "fr",
  voiceAutoSend: false,
};

const settingsFile = path.join(DATA_DIR, "settings.json");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file: string, data: unknown, mode?: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
}

let settings: Settings = { ...DEFAULTS, ...readJson<Partial<Settings>>(settingsFile, {}) };

export function getSettings(): Settings {
  return settings;
}

export function patchSettings(patch: Partial<Settings>): Settings {
  settings = { ...settings, ...patch };
  writeJsonAtomic(settingsFile, settings);
  return settings;
}

export function rememberWorkspace(dir: string) {
  const recents = [dir, ...settings.recents.filter((r) => r !== dir)].slice(0, 8);
  patchSettings({ workspace: dir, recents });
}

// ───────────────────────── Coffre à clés ─────────────────────────
// AES-256-GCM. La clé maîtresse vit dans un fichier à part (droits 0600 hors
// Windows) : un vol du seul secrets.json ne révèle rien. Ce n'est PAS un
// coffre protégé par mot de passe — quiconque lit tout ~/.starta-codeview
// peut déchiffrer. Voir SECURITY.md.

const masterFile = path.join(DATA_DIR, "master.key");
const secretsFile = path.join(DATA_DIR, "secrets.json");

function masterKey(): Buffer {
  try {
    const k = fs.readFileSync(masterFile);
    if (k.length === 32) return k;
  } catch {
    /* première utilisation */
  }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(masterFile, k, { mode: 0o600 });
  return k;
}

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

export type SecretName = ProviderId | "n8n";

function readSecrets(): Record<string, Sealed> {
  return readJson<Record<string, Sealed>>(secretsFile, {});
}

export function setSecret(name: SecretName, value: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
  const all = readSecrets();
  all[name] = { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
  writeJsonAtomic(secretsFile, all, 0o600);
}

export function getSecret(name: SecretName): string | null {
  const s = readSecrets()[name];
  if (!s) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(s.iv, "base64"));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function deleteSecret(name: SecretName) {
  const all = readSecrets();
  delete all[name];
  writeJsonAtomic(secretsFile, all, 0o600);
}

export function maskSecret(v: string | null): string {
  if (!v) return "";
  return v.length <= 10 ? "••••" : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

// ───────────────────────── Jeton de session locale ─────────────────────────

const tokenFile = path.join(DATA_DIR, "token");
export function sessionToken(): string {
  try {
    const t = fs.readFileSync(tokenFile, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {
    /* à créer */
  }
  const t = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(tokenFile, t, { mode: 0o600 });
  return t;
}

// ───────────────────────── Conversations ─────────────────────────

export interface ChatMsg {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  toolCallId?: string;
  name?: string;
  isError?: boolean;
  /** Message injecté par le serveur (ex. reprise d'une réponse coupée) : jamais montré à l'utilisateur. */
  auto?: boolean;
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  workspace: string | null;
  messages: ChatMsg[];
}

const chatFile = (id: string) => path.join(DATA_DIR, "chats", `${id.replace(/[^\w-]/g, "")}.json`);

export function loadChat(id: string): Chat | null {
  const c = readJson<Chat | null>(chatFile(id), null);
  return c;
}

export function saveChat(c: Chat) {
  c.updated = Date.now();
  writeJsonAtomic(chatFile(c.id), c);
}

export function listChats(): Omit<Chat, "messages">[] {
  const dir = path.join(DATA_DIR, "chats");
  const out: Omit<Chat, "messages">[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const c = readJson<Chat | null>(path.join(dir, f), null);
    if (c) out.push({ id: c.id, title: c.title, created: c.created, updated: c.updated, workspace: c.workspace });
  }
  return out.sort((a, b) => b.updated - a.updated).slice(0, 100);
}

export function deleteChat(id: string) {
  try {
    fs.unlinkSync(chatFile(id));
  } catch {
    /* déjà parti */
  }
}

export function newChat(workspace: string | null): Chat {
  return { id: crypto.randomUUID(), title: "Nouvelle conversation", created: Date.now(), updated: Date.now(), workspace, messages: [] };
}
