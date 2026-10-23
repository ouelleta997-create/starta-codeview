import crypto from "node:crypto";
import { getSecret, getSettings, type ChatMsg, type ProviderId } from "./store.ts";

// Quatre fournisseurs, deux dialectes : OpenAI-compatible (Z.ai, Mistral,
// OpenRouter) et Messages d'Anthropic (Claude).

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_calls"; calls: { id: string; name: string; args: Record<string, unknown> }[] }
  | { type: "usage"; input: number; output: number };

export const PROVIDERS: Record<ProviderId, { label: string; baseUrl: string; presets?: { label: string; baseUrl: string }[]; fallbackModels: string[] }> = {
  zai: {
    label: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    presets: [
      { label: "API standard", baseUrl: "https://api.z.ai/api/paas/v4" },
      { label: "GLM Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
    ],
    fallbackModels: ["glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.5-air"],
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    fallbackModels: ["devstral-medium-latest", "codestral-latest", "mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  },
  anthropic: {
    label: "Claude",
    baseUrl: "https://api.anthropic.com",
    fallbackModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    fallbackModels: ["anthropic/claude-sonnet-5-5", "openai/gpt-5", "google/gemini-3-pro", "z-ai/glm-5.1", "deepseek/deepseek-v4"],
  },
};

export function baseUrl(p: ProviderId): string {
  return (getSettings().baseUrls[p] || PROVIDERS[p].baseUrl).replace(/\/+$/, "");
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

function needKey(p: ProviderId): string {
  const k = getSecret(p);
  if (!k) throw new ProviderError(`Aucune clé ${PROVIDERS[p].label} — ajoute-la dans Réglages › Fournisseurs.`);
  return k;
}

async function failFrom(res: Response, p: ProviderId): Promise<never> {
  let detail = "";
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      detail = j?.error?.message ?? j?.message ?? j?.error ?? t;
      if (typeof detail !== "string") detail = JSON.stringify(detail);
    } catch {
      detail = t;
    }
  } catch {
    /* corps illisible */
  }
  const hint =
    res.status === 401 || res.status === 403
      ? " (clé refusée)"
      : res.status === 429
        ? " (limite de débit ou solde épuisé)"
        : "";
  throw new ProviderError(`${PROVIDERS[p].label} ${res.status}${hint} : ${detail.slice(0, 400)}`, res.status);
}

// ───────────────────────── Liste des modèles ─────────────────────────

export async function listModels(p: ProviderId): Promise<{ id: string; name?: string }[]> {
  const key = needKey(p);
  const headers: Record<string, string> =
    p === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` };
  const url = p === "anthropic" ? `${baseUrl(p)}/v1/models?limit=100` : `${baseUrl(p)}/models`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) await failFrom(res, p);
  const j = (await res.json()) as { data?: { id: string; display_name?: string; name?: string; capabilities?: { completion_chat?: boolean } }[] };
  let rows = j.data ?? [];
  if (p === "mistral") rows = rows.filter((m) => m.capabilities?.completion_chat !== false);
  const out = rows.map((m) => ({ id: m.id, name: m.display_name ?? m.name }));
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

/** Mistral exige des identifiants d'appel d'outil de 9 caractères alphanumériques. */
function mistralId(id: string): string {
  return crypto.createHash("sha256").update(id).digest("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 9).padEnd(9, "0");
}

function toOpenAI(p: ProviderId, system: string, msgs: ChatMsg[]): unknown[] {
  const fix = p === "mistral" ? mistralId : (x: string) => x;
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
  const key = needKey(p);
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAI(p, system, msgs),
    stream: true,
    tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
  };
  if (p === "openrouter") body.usage = { include: true };
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (p === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/ouelleta997-create/starta-codeview";
    headers["X-Title"] = "Starta CodeView";
  }
  const res = await fetch(`${baseUrl(p)}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) await failFrom(res, p);

  const acc = new Map<number, { id: string; name: string; args: string }>();
  for await (const ev of sse(res)) {
    if (ev.data === "[DONE]") break;
    let j: any;
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (j.error) throw new ProviderError(`${PROVIDERS[p].label} : ${j.error.message ?? JSON.stringify(j.error)}`);
    if (j.usage) yield { type: "usage", input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 };
    const d = j.choices?.[0]?.delta;
    if (!d) continue;
    const think = d.reasoning_content ?? d.reasoning;
    if (typeof think === "string" && think) yield { type: "thinking", delta: think };
    if (typeof d.content === "string" && d.content) yield { type: "text", delta: d.content };
    else if (Array.isArray(d.content)) {
      // Mistral peut renvoyer des blocs typés.
      for (const part of d.content) if (part?.type === "text" && part.text) yield { type: "text", delta: part.text };
    }
    for (const tc of d.tool_calls ?? []) {
      const idx: number = tc.index ?? 0;
      const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
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

async function* streamAnthropic(model: string, system: string, msgs: ChatMsg[], tools: ToolDef[], signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const key = needKey("anthropic");
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
  const res = await fetch(`${baseUrl("anthropic")}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await failFrom(res, "anthropic");

  const blocks = new Map<number, { id: string; name: string; json: string }>();
  let inTok = 0;
  let outTok = 0;
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
        break;
      case "error":
        throw new ProviderError(`Claude : ${j.error?.message ?? "erreur de flux"}`);
    }
  }
  yield { type: "usage", input: inTok, output: outTok };
  if (calls.length) yield { type: "tool_calls", calls };
}

export function streamChat(p: ProviderId, model: string, system: string, msgs: ChatMsg[], tools: ToolDef[], signal: AbortSignal): AsyncGenerator<StreamEvent> {
  return p === "anthropic" ? streamAnthropic(model, system, msgs, tools, signal) : streamOpenAI(p, model, system, msgs, tools, signal);
}
