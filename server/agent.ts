import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { streamChat, ProviderError, type ToolDef } from "./providers.ts";
import { FILE_TOOLS, N8N_TOOLS, executeTool, insideWorkspace, resolveIn } from "./tools.ts";
import { n8nConfigured } from "./n8n.ts";
import { SHELL_NAME } from "./shell.ts";
import { getSettings, saveChat, type Chat, type ChatMsg, type ProviderId } from "./store.ts";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; content: string; isError: boolean }
  | { type: "approval"; id: string; tool: string; title: string; detail: string }
  | { type: "usage"; input: number; output: number }
  | { type: "title"; title: string }
  | { type: "error"; message: string }
  | { type: "done"; reason: "end" | "stopped" | "loop" | "error" };

export interface RunInput {
  chat: Chat;
  text: string;
  model: { provider: ProviderId; id: string };
  context?: { file?: string; selection?: string };
  signal: AbortSignal;
  emit: (e: AgentEvent) => void;
  onTerminal: (chunk: string) => void;
  onFileChanged: (file: string) => void;
}

// ───────────────────────── Approbations ─────────────────────────

const pending = new Map<string, (allow: boolean) => void>();
export function resolveApproval(id: string, allow: boolean) {
  pending.get(id)?.(allow);
  pending.delete(id);
}
export function cancelApprovals(ids: Iterable<string>) {
  for (const id of ids) resolveApproval(id, false);
}

// ───────────────────────── Prompt système ─────────────────────────

function projectRules(workspace: string): string {
  for (const f of ["AGENTS.md", "CLAUDE.md", ".codeview/rules.md"]) {
    try {
      const t = fs.readFileSync(path.join(workspace, f), "utf8");
      return `\n\n# Consignes du projet (${f})\n${t.slice(0, 12000)}`;
    } catch {
      /* absent */
    }
  }
  return "";
}

function systemPrompt(workspace: string): string {
  const n8n = n8nConfigured();
  return `Tu es l'agent de Starta CodeView, un éditeur de code local. Tu travailles directement sur la machine de l'utilisateur, avec de vrais outils.

# Environnement
- Espace de travail : ${workspace}
- Système : ${os.type()} ${os.release()} (${process.platform}), shell des commandes : ${SHELL_NAME}
- Date : ${new Date().toISOString().slice(0, 10)}
- n8n : ${n8n ? "connecté (outils n8n_* disponibles)" : "non connecté (dis à l'utilisateur d'aller dans Réglages › n8n s'il veut des workflows)"}

# Manière de travailler
- Réponds dans la langue de l'utilisateur. Sois bref : pas de préambule, pas de récapitulatif répété de ce que les outils ont déjà montré.
- Agis, ne demande pas. Explore (list_dir, search_files, read_file) avant de modifier. Choisis un défaut raisonnable et dis-le plutôt que de poser une question.
- Modifie avec edit_file (changements ciblés) ; write_file seulement pour créer ou réécrire entièrement. Lis un fichier avant de l'éditer.
- Vérifie ton travail : lance les tests, le build ou le linter via run_command, lis les erreurs, corrige, recommence.
- Les commandes n'ont pas de stdin : utilise les options non interactives. Pas de serveurs qui ne s'arrêtent jamais.
- N'invente jamais un chemin, une API ou une variable d'affaires : vérifie dans le code, ou dis que tu ne sais pas.
- Ne touche pas aux secrets (.env, clés) sauf demande explicite, et ne les recopie pas dans tes réponses.
- Pour le code : conserve le style du code environnant (nommage, densité des commentaires).

# n8n
- Avant de modifier un workflow : n8n_get_workflow, modifie le JSON, puis n8n_update_workflow avec l'objet COMPLET.
- Un workflow créé est inactif. N'active (n8n_set_active) qu'après avoir expliqué ce qu'il fera ; l'utilisateur confirme.
- Dans connections, les clés sont des NOMS de nœuds (pas des ids). Chaque nœud a id (uuid), name unique, type (ex. n8n-nodes-base.webhook), typeVersion, position [x,y], parameters.
- Ne mets jamais de secret dans parameters : référence une credential par son nom/id et signale celles à créer dans l'interface n8n.
- Déboguer : n8n_list_executions (status=error) puis n8n_get_execution.${projectRules(workspace)}`;
}

// ───────────────────────── Contexte ─────────────────────────

/** Remplace @chemin/du/fichier par son contenu (borné) dans le message envoyé au modèle. */
function expandMentions(text: string, workspace: string): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const rel = m[1].replace(/[.,;:)]+$/, "");
    if (seen.has(rel)) continue;
    seen.add(rel);
    try {
      const abs = resolveIn(workspace, rel);
      if (!insideWorkspace(workspace, abs)) continue;
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 200 * 1024) continue;
      const body = fs.readFileSync(abs, "utf8");
      if (body.includes("\u0000")) continue;
      blocks.push(`<file path="${rel}">\n${body}\n</file>`);
    } catch {
      /* mention qui n'est pas un fichier */
    }
  }
  return blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text;
}

/** Garde la conversation sous contrôle : rogne les vieilles sorties d'outils. */
function compact(msgs: ChatMsg[]): ChatMsg[] {
  const total = msgs.reduce((n, m) => n + m.content.length, 0);
  if (total < 350_000) return msgs;
  const keepFrom = Math.max(0, msgs.length - 12);
  return msgs.map((m, i) =>
    i < keepFrom && m.role === "tool" && m.content.length > 600 ? { ...m, content: `${m.content.slice(0, 500)}\n… [sortie ancienne raccourcie]` } : m,
  );
}

// ───────────────────────── Boucle d'agent ─────────────────────────

// Pas de plafond d'étapes : l'agent travaille jusqu'au bout, même si l'utilisateur est parti.
// Deux filets seulement, pour ne pas brûler de jetons dans le vide.
const MAX_REPEATS = 10; // même appel d'outil, mêmes arguments, de suite
const MAX_RESUMES = 6; // reprises automatiques d'une réponse coupée par la limite de sortie du modèle
const RESUME_PROMPT = "Ta réponse a été coupée. Reprends exactement où tu t'es arrêté, sans répéter ce qui est déjà écrit.";

export async function runAgent(inp: RunInput): Promise<void> {
  const { chat, signal, emit } = inp;
  const workspace = chat.workspace ?? getSettings().workspace;
  if (!workspace) {
    emit({ type: "error", message: "Aucun dossier ouvert — ouvre un dossier avant de parler à l'agent." });
    emit({ type: "done", reason: "error" });
    return;
  }

  let userText = inp.text;
  if (inp.context?.selection) userText = `${userText}\n\n<selection file="${inp.context.file ?? ""}">\n${inp.context.selection.slice(0, 20000)}\n</selection>`;
  else if (inp.context?.file) userText = `[Fichier ouvert dans l'éditeur : ${inp.context.file}]\n${userText}`;
  chat.messages.push({ role: "user", content: expandMentions(userText, workspace) });
  if (chat.messages.length === 1) {
    chat.title = inp.text.replace(/\s+/g, " ").trim().slice(0, 60) || chat.title;
    emit({ type: "title", title: chat.title });
  }
  saveChat(chat);

  const tools: ToolDef[] = [...FILE_TOOLS, ...(n8nConfigured() ? N8N_TOOLS : [])];
  const system = systemPrompt(workspace);
  const myApprovals = new Set<string>();
  let reason: "end" | "stopped" | "loop" | "error" = "end";
  let lastSig = "";
  let repeats = 0;
  let resumes = 0;

  try {
    for (;;) {
      let text = "";
      let truncated = false;
      let calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
      for await (const ev of streamChat(inp.model.provider, inp.model.id, system, compact(chat.messages), tools, signal)) {
        if (ev.type === "text") {
          text += ev.delta;
          emit({ type: "text", delta: ev.delta });
        } else if (ev.type === "thinking") emit(ev);
        else if (ev.type === "usage") emit(ev);
        else if (ev.type === "tool_calls") calls = ev.calls;
        else if (ev.type === "truncated") truncated = true;
      }
      const assistant: ChatMsg = { role: "assistant", content: text };
      if (calls.length) assistant.toolCalls = calls;
      chat.messages.push(assistant);
      saveChat(chat);
      if (!calls.length) {
        if (!truncated || resumes >= MAX_RESUMES || signal.aborted) break;
        resumes++;
        chat.messages.push({ role: "user", content: RESUME_PROMPT, auto: true });
        saveChat(chat);
        continue;
      }
      resumes = 0;

      const sig = calls.map((c) => `${c.name}:${JSON.stringify(c.args)}`).join("|");
      repeats = sig === lastSig ? repeats + 1 : 0;
      lastSig = sig;
      if (repeats >= MAX_REPEATS - 1) {
        reason = "loop";
        emit({ type: "error", message: `Boucle détectée : l'agent a répété ${MAX_REPEATS} fois la même action. Arrêt automatique — reformule ou change d'approche.` });
        break;
      }

      for (const call of calls) {
        emit({ type: "tool_start", id: call.id, name: call.name, args: call.args });
        const outcome = signal.aborted
          ? { content: "Interrompu.", isError: true }
          : await executeTool(call.name, call.args as Record<string, any>, {
              workspace,
              signal,
              onTerminal: inp.onTerminal,
              onFileChanged: inp.onFileChanged,
              approve: (req) =>
                new Promise<boolean>((resolve) => {
                  const id = crypto.randomUUID();
                  myApprovals.add(id);
                  pending.set(id, resolve);
                  signal.addEventListener("abort", () => resolveApproval(id, false), { once: true });
                  emit({ type: "approval", id, ...req });
                }),
            });
        emit({ type: "tool_result", id: call.id, content: outcome.content.slice(0, 60000), isError: !!outcome.isError });
        chat.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: outcome.content, isError: outcome.isError });
      }
      saveChat(chat);
      if (signal.aborted) break;
    }
    if (signal.aborted) reason = "stopped";
  } catch (e) {
    if (signal.aborted) reason = "stopped";
    else {
      reason = "error";
      const msg = e instanceof ProviderError ? e.message : `Erreur : ${(e as Error).message}`;
      emit({ type: "error", message: msg });
      // Retire un éventuel tour d'assistant incomplet pour garder l'historique valide.
      const last = chat.messages[chat.messages.length - 1];
      if (last?.role === "user") chat.messages.pop();
    }
  } finally {
    // Un appel d'outil sans réponse casserait la conversation chez les fournisseurs : on complète.
    const answered = new Set(chat.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
    const lastAssistant = [...chat.messages].reverse().find((m) => m.role === "assistant");
    for (const c of lastAssistant?.toolCalls ?? []) {
      if (!answered.has(c.id)) chat.messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: "Interrompu.", isError: true });
    }
    cancelApprovals(myApprovals);
    saveChat(chat);
    emit({ type: "done", reason });
  }
}
