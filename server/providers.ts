import crypto from "node:crypto";
import { getSecret, getSettings, type ChatMsg, type ProviderId } from "./store.ts";

// Deux dialectes : OpenAI chat/completions (presque tout le monde) et Messages d'Anthropic (Claude).
// Ajouter un fournisseur compatible OpenAI = ajouter UNE entrée à PROVIDERS ci-dessous, rien d'autre.

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_calls"; calls: { id: string; name: string; args: Record<string, unknown> }[] }
  | { type: "usage"; input: number; output: number }
  /** Le modèle a atteint sa limite de sortie : la réponse est coupée en plein milieu. */
  | { type: "truncated" };

export interface ProviderDef {
  label: string;
  /** Adresse de base, sans « /chat/completions » ni « /models » à la fin. */
  baseUrl: string;
  /** Dialecte : « openai » (défaut) ou « anthropic ». */
  kind?: "openai" | "anthropic";
  /** Autres adresses officielles (régions, forfaits). */
  presets?: { label: string; baseUrl: string }[];
  /** Page où créer une clé API. */
  keyUrl?: string;
  keyHint?: string;
  /** Serveur local sans clé (Ollama, LM Studio…) : « Activer » suffit. */
  keyless?: boolean;
  /** Adresse à saisir soi-même : n'importe quel serveur compatible OpenAI. */
  custom?: boolean;
  /** Modèles proposés si la liste en direct est indisponible. */
  fallbackModels: string[];
  /** Demande le décompte de jetons en streaming (stream_options.include_usage). */
  streamUsage?: boolean;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Mistral exige des identifiants d'appel d'outil de 9 caractères alphanumériques. */
  mistralIds?: boolean;
  /** Préfixe à retirer des identifiants de la liste (Gemini renvoie « models/… »). */
  stripModelPrefix?: string;
  /** La liste des modèles est publique : la tester ne prouve rien sur la clé. */
  publicModels?: boolean;
}

// L'ordre ci-dessous est celui de l'interface.
export const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: {
    label: "Claude",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    fallbackModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    streamUsage: true,
    fallbackModels: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    stripModelPrefix: "models/",
    fallbackModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  xai: {
    label: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    keyHint: "xai-…",
    streamUsage: true,
    fallbackModels: ["grok-4", "grok-code-fast-1", "grok-3"],
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-…",
    streamUsage: true,
    fallbackModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  zai: {
    label: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    presets: [
      { label: "API standard", baseUrl: "https://api.z.ai/api/paas/v4" },
      { label: "GLM Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
    ],
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    keyHint: "Clé API Z.ai",
    fallbackModels: ["glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.5-air"],
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    keyHint: "Clé API Mistral",
    mistralIds: true,
    fallbackModels: ["devstral-medium-latest", "codestral-latest", "mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    publicModels: true,
    keyUrl: "https://openrouter.ai/settings/keys",
    keyHint: "sk-or-…",
    extraHeaders: { "HTTP-Referer": "https://github.com/ouelleta997-create/starta-codeview", "X-Title": "Starta CodeView" },
    extraBody: { usage: { include: true } },
    fallbackModels: ["anthropic/claude-sonnet-5-5", "openai/gpt-5", "google/gemini-3-pro", "z-ai/glm-5.1", "deepseek/deepseek-v4"],
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    keyHint: "gsk_…",
    streamUsage: true,
    fallbackModels: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "moonshotai/kimi-k2-instruct"],
  },
  together: {
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    keyUrl: "https://api.together.ai/settings/api-keys",
    keyHint: "Clé API Together",
    streamUsage: true,
    fallbackModels: ["deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  },
  fireworks: {
    label: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    keyHint: "fw_…",
    streamUsage: true,
    fallbackModels: ["accounts/fireworks/models/deepseek-v3p1", "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct"],
  },
  cerebras: {
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyUrl: "https://cloud.cerebras.ai",
    keyHint: "csk-…",
    streamUsage: true,
    fallbackModels: ["gpt-oss-120b", "qwen-3-coder-480b", "llama-3.3-70b"],
  },
  moonshot: {
    label: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    presets: [
      { label: "International", baseUrl: "https://api.moonshot.ai/v1" },
      { label: "Chine", baseUrl: "https://api.moonshot.cn/v1" },
    ],
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    keyHint: "sk-…",
    fallbackModels: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview"],
  },
  qwen: {
    label: "Alibaba Qwen",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    presets: [
      { label: "International", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
      { label: "Chine", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    ],
    keyUrl: "https://www.alibabacloud.com/help/en/model-studio/get-api-key",
    keyHint: "sk-…",
    fallbackModels: ["qwen3-coder-plus", "qwen-plus", "qwen-max"],
  },
  minimax: {
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    presets: [
      { label: "International", baseUrl: "https://api.minimax.io/v1" },
      { label: "Chine", baseUrl: "https://api.minimaxi.com/v1" },
    ],
    keyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    keyHint: "Clé API MiniMax",
    fallbackModels: ["MiniMax-M2"],
  },
  sambanova: {
    label: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    publicModels: true,
    keyUrl: "https://cloud.sambanova.ai/apis",
    keyHint: "Clé API SambaNova",
    fallbackModels: ["DeepSeek-V3.1", "gpt-oss-120b", "Meta-Llama-3.3-70B-Instruct"],
  },
  nvidia: {
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    publicModels: true,
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    keyHint: "nvapi-…",
    fallbackModels: ["meta/llama-3.3-70b-instruct", "deepseek-ai/deepseek-v3.1"],
  },
  huggingface: {
    label: "Hugging Face",
    baseUrl: "https://router.huggingface.co/v1",
    publicModels: true,
    keyUrl: "https://huggingface.co/settings/tokens",
    keyHint: "hf_…",
    fallbackModels: ["openai/gpt-oss-120b", "Qwen/Qwen3-Coder-480B-A35B-Instruct"],
  },
  cohere: {
    label: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    keyUrl: "https://dashboard.cohere.com/api-keys",
    keyHint: "Clé API Cohere",
    fallbackModels: ["command-a-03-2025", "command-r-plus"],
  },
  nebius: {
    label: "Nebius",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    presets: [
      { label: "Token Factory", baseUrl: "https://api.tokenfactory.nebius.com/v1" },
      { label: "AI Studio (ancienne adresse)", baseUrl: "https://api.studio.nebius.com/v1" },
    ],
    keyUrl: "https://tokenfactory.nebius.com",
    keyHint: "Clé API Nebius",
    fallbackModels: ["deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-Coder-480B-A35B-Instruct"],
  },
  hyperbolic: {
    label: "Hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    keyUrl: "https://app.hyperbolic.xyz/settings",
    keyHint: "Clé API Hyperbolic",
    fallbackModels: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-Coder-480B-A35B-Instruct"],
  },
  novita: {
    label: "Novita AI",
    baseUrl: "https://api.novita.ai/v3/openai",
    publicModels: true,
    keyUrl: "https://novita.ai/settings/key-management",
    keyHint: "Clé API Novita",
    fallbackModels: ["deepseek/deepseek-v3.1"],
  },
  siliconflow: {
    label: "SiliconFlow",
    baseUrl: "https://api.siliconflow.com/v1",
    keyUrl: "https://cloud.siliconflow.com/account/ak",
    keyHint: "sk-…",
    fallbackModels: ["deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-Coder-480B-A35B-Instruct"],
  },
  ollama: {
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    keyUrl: "https://ollama.com/download",
    keyless: true,
    fallbackModels: [],
  },
  lmstudio: {
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    keyUrl: "https://lmstudio.ai",
    keyless: true,
    fallbackModels: [],
  },
  custom: {
    label: "Autre (compatible OpenAI)",
    baseUrl: "",
    custom: true,
    keyHint: "Clé (facultative)",
    fallbackModels: [],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** Valeur enregistrée quand un fournisseur n'a pas de clé (serveur local activé). */
const NO_KEY = "none";

function def(p: ProviderId): ProviderDef {
  const d = PROVIDERS[p];
  if (!d) throw new ProviderError(`Fournisseur inconnu : « ${p} ». Choisis un modèle dans la liste.`);
  return d;
}

export function baseUrl(p: ProviderId): string {
  return (getSettings().baseUrls[p] || PROVIDERS[p]?.baseUrl || "").replace(/\/+$/, "");
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Clé à envoyer ; chaîne vide pour un serveur sans clé. */
function needKey(p: ProviderId): string {
  const d = def(p);
  const k = getSecret(p);
  if (!k) throw new ProviderError(d.keyless || d.custom ? `${d.label} n'est pas activé — ajoute-le dans Réglages › Fournisseurs.` : `Aucune clé ${d.label} — ajoute-la dans Réglages › Fournisseurs.`);
  if (d.custom && !baseUrl(p)) throw new ProviderError(`${d.label} : renseigne l'adresse du serveur dans Réglages › Fournisseurs.`);
  return k === NO_KEY ? "" : k;
}

async function failFrom(res: Response, p: ProviderId): Promise<never> {
  let detail = "";
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      detail = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail ?? t;
      if (typeof detail !== "string") detail = JSON.stringify(detail);
    } catch {
      detail = t;
    }
  } catch {
    /* corps illisible */
  }
  const hint =
    res.status === 401 || res.status === 403 || (res.status === 400 && /api[ _-]?key/i.test(detail))
      ? " (clé refusée)"
      : res.status === 429
        ? " (limite de débit ou solde épuisé)"
        : "";
  throw new ProviderError(`${PROVIDERS[p]?.label ?? p} ${res.status}${hint} : ${detail.slice(0, 400)}`, res.status);
}

// ───────────────────────── Liste des modèles ─────────────────────────

// Les listes mélangent embeddings, voix, images… : on ne garde que ce qui peut discuter.
const NOT_CHAT = /embed|whisper|tts|moderation|rerank|dall-e|image|davinci|babbage|transcribe|realtime|audio|guard|speech|ocr/i;

export async function listModels(p: ProviderId): Promise<{ id: string; name?: string }[]> {
  const d = def(p);
  const key = needKey(p);
  const headers: Record<string, string> = d.kind === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...d.extraHeaders };
  const url = d.kind === "anthropic" ? `${baseUrl(p)}/v1/models?limit=100` : `${baseUrl(p)}/models`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) await failFrom(res, p);
  const j = (await res.json()) as unknown;
  // La plupart renvoient { data: [...] } ; Together renvoie directement un tableau ; certains { models: [...] }.
  const rows: any[] = Array.isArray(j) ? j : ((j as any)?.data ?? (j as any)?.models ?? []);
  const seen = new Set<string>();
  const out: { id: string; name?: string }[] = [];
  for (const m of rows) {
    let id: string = typeof m === "string" ? m : (m?.id ?? m?.name ?? "");
    if (!id) continue;
    if (d.stripModelPrefix && id.startsWith(d.stripModelPrefix)) id = id.slice(d.stripModelPrefix.length);
    if (m?.capabilities?.completion_chat === false) continue; // Mistral
    if (m?.type && !["chat", "language", "code"].includes(String(m.type))) continue; // Together
    if (d.kind !== "anthropic" && !d.keyless && !d.custom && NOT_CHAT.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: m?.display_name ?? (typeof m === "object" ? m?.name : undefined) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ───────────────────────── Streaming ─────────────────────────

async function* sse(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}

function safeJson(s: string): Record<string, unknown> {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return { __raw: s };
  }
}

const isCompleteJson = (s: string) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

function mistralId(id: string): string {
  return crypto.createHash("sha256").update(id).digest("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 9).padEnd(9, "0");
}

function toOpenAI(d: ProviderDef, system: string, msgs: ChatMsg[]): unknown[] {
  const fix = d.mistralIds ? mistralId : (x: string) => x;
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of msgs) {
    if (m.role === "assistant") {
      const o: Record<string, unknown> = { role: "assistant", content: m.content || (m.toolCalls?.length ? null : "") };
      if (m.toolCalls?.length) {
        o.tool_calls = m.toolCalls.map((c) => ({ id: fix(c.id), type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      }
      out.push(o);
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: fix(m.toolCallId ?? ""), name: m.name, content: m.content });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}

async function* streamOpenAI(p: ProviderId, model: string, system: string, msgs: ChatMsg[], tools: ToolDef[], signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const d = def(p);
  const key = needKey(p);
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAI(d, system, msgs),
    stream: true,
    tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    ...(d.streamUsage ? { stream_options: { include_usage: true } } : {}),
    ...d.extraBody,
  };
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...d.extraHeaders };
  const res = await fetch(`${baseUrl(p)}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) await failFrom(res, p);

  const acc = new Map<number, { id: string; name: string; args: string }>();
  let truncated = false;
  for await (const ev of sse(res)) {
    if (ev.data === "[DONE]") break;
    let j: any;
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (j.error) throw new ProviderError(`${d.label} : ${j.error.message ?? JSON.stringify(j.error)}`);
    if (j.usage) yield { type: "usage", input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 };
    if (j.choices?.[0]?.finish_reason === "length") truncated = true;
    const delta = j.choices?.[0]?.delta;
    if (!delta) continue;
    const think = delta.reasoning_content ?? delta.reasoning;
    if (typeof think === "string" && think) yield { type: "thinking", delta: think };
    if (typeof delta.content === "string" && delta.content) yield { type: "text", delta: delta.content };
    else if (Array.isArray(delta.content)) {
      // Mistral peut renvoyer des blocs typés.
      for (const part of delta.content) if (part?.type === "text" && part.text) yield { type: "text", delta: part.text };
    }
    for (const tc of delta.tool_calls ?? []) {
      let idx: number = tc.index ?? 0;
      let cur = acc.get(idx);
      // Gemini numérote 0 tous les appels parallèles : un autre identifiant, ou un nom qui arrive alors que les
      // arguments précédents sont déjà complets, ouvre un nouvel appel au lieu de fusionner les deux.
      if (cur && ((tc.id && cur.id && tc.id !== cur.id) || (tc.function?.name && cur.args && isCompleteJson(cur.args)))) {
        idx = Math.max(...acc.keys()) + 1;
        cur = undefined;
      }
      cur ??= { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      acc.set(idx, cur);
    }
  }
  if (acc.size) {
    const calls = [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id || `call_${crypto.randomBytes(6).toString("hex")}`, name: c.name, args: safeJson(c.args) }));
    yield { type: "tool_calls", calls };
  }
  if (truncated) yield { type: "truncated" };
}

function toAnthropic(msgs: ChatMsg[]): unknown[] {
  const out: { role: string; content: unknown[] }[] = [];
  const push = (role: string, block: unknown) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of msgs) {
    if (m.role === "user") push("user", { type: "text", text: m.content || "(vide)" });
    else if (m.role === "assistant") {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.args });
    } else {
      push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content || "(aucune sortie)", is_error: !!m.isError });
    }
  }
  return out;
}

async function* streamAnthropic(p: ProviderId, model: string, system: string, msgs: ChatMsg[], tools: ToolDef[], signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const key = needKey(p);
  const body = {
    model,
    max_tokens: 16000,
    stream: true,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: toAnthropic(msgs),
    tools: tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    })),
  };
  const res = await fetch(`${baseUrl(p)}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await failFrom(res, p);

  const blocks = new Map<number, { id: string; name: string; json: string }>();
  let inTok = 0;
  let outTok = 0;
  let truncated = false;
  const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
  for await (const ev of sse(res)) {
    let j: any;
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    switch (j.type) {
      case "message_start": {
        const u = j.message?.usage ?? {};
        inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        break;
      }
      case "content_block_start":
        if (j.content_block?.type === "tool_use") blocks.set(j.index, { id: j.content_block.id, name: j.content_block.name, json: "" });
        break;
      case "content_block_delta":
        if (j.delta?.type === "text_delta") yield { type: "text", delta: j.delta.text };
        else if (j.delta?.type === "thinking_delta") yield { type: "thinking", delta: j.delta.thinking };
        else if (j.delta?.type === "input_json_delta") {
          const b = blocks.get(j.index);
          if (b) b.json += j.delta.partial_json ?? "";
        }
        break;
      case "content_block_stop": {
        const b = blocks.get(j.index);
        if (b) {
          calls.push({ id: b.id, name: b.name, args: safeJson(b.json) });
          blocks.delete(j.index);
        }
        break;
      }
      case "message_delta":
        outTok = j.usage?.output_tokens ?? outTok;
        if (j.delta?.stop_reason === "max_tokens") truncated = true;
        break;
      case "error":
        throw new ProviderError(`Claude : ${j.error?.message ?? "erreur de flux"}`);
    }
  }
  yield { type: "usage", input: inTok, output: outTok };
  if (calls.length) yield { type: "tool_calls", calls };
  if (truncated) yield { type: "truncated" };
}

export function streamChat(p: ProviderId, model: string, system: string, msgs: ChatMsg[], tools: ToolDef[], signal: AbortSignal): AsyncGenerator<StreamEvent> {
  return def(p).kind === "anthropic" ? streamAnthropic(p, model, system, msgs, tools, signal) : streamOpenAI(p, model, system, msgs, tools, signal);
}
