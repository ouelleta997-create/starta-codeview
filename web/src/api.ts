export interface VoiceInfo { installed: boolean; state: "off" | "loading" | "ready" | "error"; model: string; device: string; error: string }
export interface Entry { name: string; dir: boolean; path: string; ignored: boolean }
export interface ProviderState { label: string; configured: boolean; masked: string; baseUrl: string; defaultBaseUrl: string; presets: { label: string; baseUrl: string }[] }
export type ProviderId = "zai" | "mistral" | "anthropic" | "openrouter";
export const PROVIDER_ORDER: ProviderId[] = ["anthropic", "zai", "mistral", "openrouter"];
export interface AppState {
  version: string;
  settings: {
    workspace: string | null; recents: string[]; approval: "auto" | "ask"; theme: "dark" | "light" | "system";
    model: { provider: ProviderId; id: string } | null; baseUrls: Partial<Record<ProviderId, string>>; n8nUrl: string;
    voiceModel: string; voiceLang: string; voiceAutoSend: boolean;
  };
  providers: Record<ProviderId, ProviderState>;
  n8n: { url: string; configured: boolean; masked: string };
  voice: VoiceInfo;
  platform: string; shell: string; home: string; dataDir: string;
}
export interface ModelList { live: boolean; error?: string; models: { id: string; name?: string }[] }
export interface Workflow { id: string; name: string; active: boolean; updatedAt?: string; nodes?: number; tags?: string[] }
export interface ChatMeta { id: string; title: string; updated: number }

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
  return data as T;
}

type Handler = (msg: any) => void;
let sock: WebSocket | null = null;
let handler: Handler = () => {};
let onState: (up: boolean) => void = () => {};
let retry = 0;

export function connectWs(h: Handler, st: (up: boolean) => void) {
  handler = h; onState = st;
  const open = () => {
    sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    sock.onopen = () => { retry = 0; onState(true); };
    sock.onmessage = (e) => { try { handler(JSON.parse(e.data)); } catch { /* ignoré */ } };
    sock.onclose = () => { onState(false); setTimeout(open, Math.min(500 * ++retry, 5000)); };
  };
  open();
}

export function wsSend(msg: unknown): boolean {
  if (sock?.readyState !== 1) return false;
  sock.send(JSON.stringify(msg));
  return true;
}
