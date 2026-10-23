import { getSecret, getSettings } from "./store.ts";

// Client minimal de l'API publique n8n (/api/v1). Authentification : X-N8N-API-KEY.

export class N8nError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

export function n8nConfigured(): boolean {
  return !!(getSettings().n8nUrl && getSecret("n8n"));
}

function root(): string {
  const url = getSettings().n8nUrl.trim().replace(/\/+$/, "");
  if (!url) throw new N8nError("n8n n'est pas connecté — renseigne l'URL et la clé dans Réglages › n8n.");
  return url.replace(/\/api\/v1$/, "");
}

export async function n8n<T = any>(method: string, route: string, body?: unknown): Promise<T> {
  const key = getSecret("n8n");
  if (!key) throw new N8nError("Clé API n8n manquante — Réglages › n8n.");
  const res = await fetch(`${root()}/api/v1${route}`, {
    method,
    headers: { "X-N8N-API-KEY": key, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch {
      /* texte brut */
    }
    const hint = res.status === 401 ? " (clé API refusée)" : res.status === 404 ? " (introuvable — vérifie l'URL)" : "";
    throw new N8nError(`n8n ${res.status}${hint} : ${String(msg).slice(0, 600)}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** L'API n'accepte que ces champs à la création / mise à jour d'un workflow. */
export function cleanWorkflow(w: any) {
  const settings = w.settings && typeof w.settings === "object" ? w.settings : {};
  // Champs de settings que l'API refuse selon les versions.
  const allowed = ["executionOrder", "saveExecutionProgress", "saveManualExecutions", "saveDataErrorExecution", "saveDataSuccessExecution", "executionTimeout", "errorWorkflow", "timezone", "callerPolicy"];
  const s: Record<string, unknown> = {};
  for (const k of allowed) if (k in settings) s[k] = settings[k];
  if (!("executionOrder" in s)) s.executionOrder = "v1";
  return { name: String(w.name ?? "Sans titre"), nodes: w.nodes ?? [], connections: w.connections ?? {}, settings: s };
}

export async function listWorkflows() {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const r = await n8n<{ data: any[]; nextCursor?: string }>("GET", `/workflows?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...r.data);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out.map((w) => ({ id: w.id, name: w.name, active: !!w.active, updatedAt: w.updatedAt, nodes: Array.isArray(w.nodes) ? w.nodes.length : undefined, tags: (w.tags ?? []).map((t: any) => t.name) }));
}

export const getWorkflow = (id: string) => n8n("GET", `/workflows/${encodeURIComponent(id)}`);
export const createWorkflow = (w: unknown) => n8n("POST", "/workflows", cleanWorkflow(w));
export const updateWorkflow = (id: string, w: unknown) => n8n("PUT", `/workflows/${encodeURIComponent(id)}`, cleanWorkflow(w));
export const setActive = (id: string, active: boolean) => n8n("POST", `/workflows/${encodeURIComponent(id)}/${active ? "activate" : "deactivate"}`);
export const deleteWorkflow = (id: string) => n8n("DELETE", `/workflows/${encodeURIComponent(id)}`);

export async function listExecutions(workflowId?: string, status?: string, limit = 10) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (workflowId) q.set("workflowId", workflowId);
  if (status) q.set("status", status);
  const r = await n8n<{ data: any[] }>("GET", `/executions?${q}`);
  return r.data.map((e) => ({ id: e.id, workflowId: e.workflowId, status: e.status, mode: e.mode, startedAt: e.startedAt, stoppedAt: e.stoppedAt }));
}

export const getExecution = (id: string) => n8n("GET", `/executions/${encodeURIComponent(id)}?includeData=true`);

/** Déclenche un nœud Webhook (production ou test). */
export async function callWebhook(webhookPath: string, method: string, body: unknown, test: boolean) {
  const p = webhookPath.replace(/^\/+/, "").replace(/^webhook(-test)?\//, "");
  const res = await fetch(`${root()}/${test ? "webhook-test" : "webhook"}/${p}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 8000) };
}
