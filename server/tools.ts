import fs from "node:fs";
import path from "node:path";
import type { ToolDef } from "./providers.ts";
import { runCommand, isDangerous, SHELL_NAME } from "./shell.ts";
import * as n8n from "./n8n.ts";
import { getSettings } from "./store.ts";

export interface ToolCtx {
  workspace: string;
  signal: AbortSignal;
  /** Demande une confirmation à l'utilisateur ; résout true s'il accepte. */
  approve: (req: { tool: string; title: string; detail: string }) => Promise<boolean>;
  /** Sortie en direct d'une commande (pour le terminal). */
  onTerminal: (chunk: string) => void;
  onFileChanged: (file: string) => void;
}

export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "__pycache__", "target", ".cache", ".turbo", "coverage", ".astro"]);

const MAX_READ = 400 * 1024;

export function resolveIn(workspace: string, p: string): string {
  return path.resolve(workspace, p || ".");
}

export function insideWorkspace(workspace: string, abs: string): boolean {
  const rel = path.relative(workspace, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

export const FILE_TOOLS: ToolDef[] = [
  {
    name: "list_dir",
    description: "Liste le contenu d'un dossier (relatif à l'espace de travail). depth=1 par défaut, 4 max. Ignore node_modules, .git, dist.",
    parameters: obj({ path: str("Dossier, '.' pour la racine"), depth: { type: "integer", minimum: 1, maximum: 4 } }),
  },
  {
    name: "read_file",
    description: "Lit un fichier texte. Utilise start_line/end_line (1-indexés) pour les gros fichiers. Les lignes sont numérotées dans la sortie.",
    parameters: obj({ path: str("Chemin du fichier"), start_line: { type: "integer" }, end_line: { type: "integer" } }, ["path"]),
  },
  {
    name: "write_file",
    description: "Crée un fichier ou remplace entièrement son contenu (crée les dossiers parents). Pour modifier un fichier existant, préfère edit_file.",
    parameters: obj({ path: str("Chemin du fichier"), content: str("Contenu complet") }, ["path", "content"]),
  },
  {
    name: "edit_file",
    description: "Remplace un extrait exact d'un fichier. old_string doit apparaître UNE seule fois (sinon ajoute du contexte ou replace_all=true). Lis le fichier d'abord.",
    parameters: obj(
      { path: str("Chemin du fichier"), old_string: str("Texte exact à remplacer"), new_string: str("Nouveau texte"), replace_all: { type: "boolean" } },
      ["path", "old_string", "new_string"],
    ),
  },
  {
    name: "search_files",
    description: "Cherche une expression régulière (insensible à la casse) dans les fichiers texte. Renvoie fichier:ligne:texte (200 max). files_only=true pour chercher par NOM de fichier.",
    parameters: obj({ pattern: str("Regex JavaScript"), path: str("Dossier de départ, '.' par défaut"), files_only: { type: "boolean" } }, ["pattern"]),
  },
  {
    name: "run_command",
    description: `Exécute une commande dans le terminal local (${SHELL_NAME}) et renvoie le code de sortie + la sortie. Pas d'interactivité (stdin fermé) : passe des options non interactives (-y, --yes). Délai par défaut 120 s (max 600). Les processus longs (serveurs de dev) ne conviennent pas : lance-les avec un délai court ou en arrière-plan.`,
    parameters: obj({ command: str("Commande"), cwd: str("Dossier de travail (relatif), racine par défaut"), timeout_sec: { type: "integer", minimum: 1, maximum: 600 } }, ["command"]),
  },
];

export const N8N_TOOLS: ToolDef[] = [
  {
    name: "n8n_list_workflows",
    description: "Liste les workflows n8n (id, nom, actif, nombre de nœuds).",
    parameters: obj({}),
  },
  {
    name: "n8n_get_workflow",
    description: "Récupère le JSON complet d'un workflow n8n. À faire AVANT toute modification.",
    parameters: obj({ id: str("Identifiant du workflow") }, ["id"]),
  },
  {
    name: "n8n_create_workflow",
    description:
      "Crée un workflow n8n (inactif). workflow = {name, nodes:[{id,name,type,typeVersion,position:[x,y],parameters,credentials?}], connections:{\"Nom du nœud source\":{main:[[{node:\"Nom cible\",type:\"main\",index:0}]]}}, settings?}. Les noms de nœuds sont les clés de connections.",
    parameters: obj({ workflow: { type: "object", description: "Définition du workflow" } }, ["workflow"]),
  },
  {
    name: "n8n_update_workflow",
    description: "Remplace un workflow existant par la définition fournie (fais n8n_get_workflow d'abord, modifie, renvoie le tout).",
    parameters: obj({ id: str("Identifiant"), workflow: { type: "object", description: "Définition complète" } }, ["id", "workflow"]),
  },
  {
    name: "n8n_set_active",
    description: "Active ou désactive un workflow. L'activation exige l'accord de l'utilisateur.",
    parameters: obj({ id: str("Identifiant"), active: { type: "boolean" } }, ["id", "active"]),
  },
  {
    name: "n8n_delete_workflow",
    description: "Supprime un workflow (exige l'accord de l'utilisateur).",
    parameters: obj({ id: str("Identifiant") }, ["id"]),
  },
  {
    name: "n8n_list_executions",
    description: "Liste les dernières exécutions (status: success|error|waiting|running).",
    parameters: obj({ workflow_id: str("Filtrer par workflow"), status: str("Filtrer par statut"), limit: { type: "integer", maximum: 50 } }),
  },
  {
    name: "n8n_get_execution",
    description: "Détail d'une exécution avec données par nœud (utile pour déboguer une erreur).",
    parameters: obj({ id: str("Identifiant d'exécution") }, ["id"]),
  },
  {
    name: "n8n_call_webhook",
    description: "Appelle le nœud Webhook d'un workflow (chemin tel que configuré). test=true cible l'URL de test. Exige l'accord de l'utilisateur en mode prudent.",
    parameters: obj({ path: str("Chemin du webhook"), method: str("GET ou POST"), body: { type: "object" }, test: { type: "boolean" } }, ["path"]),
  },
];

// ───────────────────────── Exécution ─────────────────────────

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

const ok = (content: string): ToolOutcome => ({ content });
const err = (content: string): ToolOutcome => ({ content, isError: true });

function walk(root: string, depth: number, out: string[], prefix = "", limit = 400) {
  if (out.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) {
      out.push(`${prefix}${e.name}/  (ignoré)`);
      continue;
    }
    out.push(e.isDirectory() ? `${prefix}${e.name}/` : `${prefix}${e.name}`);
    if (out.length >= limit) return;
    if (e.isDirectory() && depth > 1) walk(root, depth - 1, out, `${prefix}${e.name}/`, limit);
  }
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function* iterFiles(root: string, limit = 20000): Generator<string> {
  let count = 0;
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        if (++count > limit) return;
        yield rel ? `${rel}/${e.name}` : e.name;
      }
    }
  }
}

export function needsApproval(name: string, args: Record<string, any>, ctx: { workspace: string }): { title: string; detail: string } | null {
  const ask = getSettings().approval === "ask";
  const abs = typeof args.path === "string" ? resolveIn(ctx.workspace, args.path) : "";
  switch (name) {
    case "write_file":
    case "edit_file":
      if (!insideWorkspace(ctx.workspace, abs)) return { title: "Écriture hors de l'espace de travail", detail: abs };
      return ask ? { title: name === "write_file" ? "Écrire le fichier" : "Modifier le fichier", detail: abs } : null;
    case "run_command":
      if (isDangerous(String(args.command ?? ""))) return { title: "Commande potentiellement destructrice", detail: String(args.command) };
      return ask ? { title: "Exécuter la commande", detail: String(args.command) } : null;
    case "n8n_create_workflow":
    case "n8n_update_workflow":
      return ask ? { title: name === "n8n_create_workflow" ? "Créer un workflow n8n" : `Modifier le workflow n8n ${args.id}`, detail: String(args.workflow?.name ?? args.id ?? "") } : null;
    case "n8n_set_active":
      return args.active ? { title: "Activer le workflow n8n", detail: String(args.id) } : ask ? { title: "Désactiver le workflow n8n", detail: String(args.id) } : null;
    case "n8n_delete_workflow":
      return { title: "Supprimer le workflow n8n", detail: String(args.id) };
    case "n8n_call_webhook":
      return !args.test || ask ? { title: "Appeler un webhook n8n", detail: `${args.method ?? "POST"} /${args.test ? "webhook-test" : "webhook"}/${String(args.path).replace(/^\/+/, "")}` } : null;
    case "read_file":
    case "list_dir":
    case "search_files":
      return null;
    default:
      return null;
  }
}

export async function executeTool(name: string, args: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  try {
    const need = needsApproval(name, args, ctx);
    if (need && !(await ctx.approve({ tool: name, ...need }))) return err("L'utilisateur a refusé cette action. Propose une alternative ou demande-lui comment procéder.");
    if (ctx.signal.aborted) return err("Interrompu.");

    switch (name) {
      case "list_dir": {
        const abs = resolveIn(ctx.workspace, args.path ?? ".");
        const out: string[] = [];
        walk(abs, Math.min(Math.max(Number(args.depth) || 1, 1), 4), out);
        return ok(out.length ? out.join("\n") : "(dossier vide ou introuvable)");
      }
      case "read_file": {
        const abs = resolveIn(ctx.workspace, args.path);
        const st = fs.statSync(abs);
        if (st.isDirectory()) return err("C'est un dossier — utilise list_dir.");
        const buf = fs.readFileSync(abs);
        if (isBinary(buf)) return err("Fichier binaire, lecture impossible.");
        const lines = buf.toString("utf8").split(/\r?\n/);
        const a = Math.max(1, Number(args.start_line) || 1);
        const b = Math.min(lines.length, Number(args.end_line) || lines.length);
        let text = lines
          .slice(a - 1, b)
          .map((l, i) => `${String(a + i).padStart(5)}  ${l}`)
          .join("\n");
        if (text.length > MAX_READ) text = `${text.slice(0, MAX_READ)}\n… [tronqué — relis avec start_line/end_line, ${lines.length} lignes au total]`;
        return ok(text || "(fichier vide)");
      }
      case "write_file": {
        const abs = resolveIn(ctx.workspace, args.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const existed = fs.existsSync(abs);
        fs.writeFileSync(abs, String(args.content ?? ""));
        ctx.onFileChanged(abs);
        return ok(`${existed ? "Fichier remplacé" : "Fichier créé"} : ${args.path} (${String(args.content ?? "").length} caractères)`);
      }
      case "edit_file": {
        const abs = resolveIn(ctx.workspace, args.path);
        const src = fs.readFileSync(abs, "utf8");
        const oldS = String(args.old_string ?? "");
        const newS = String(args.new_string ?? "");
        if (!oldS) return err("old_string est vide.");
        // Tolère CRLF dans le fichier quand le modèle a écrit du LF.
        const crlf = src.includes("\r\n");
        const norm = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);
        const needle = src.includes(oldS) ? oldS : norm(oldS);
        const count = src.split(needle).length - 1;
        if (count === 0) return err("old_string introuvable dans le fichier. Relis le fichier (read_file) et copie l'extrait exactement.");
        if (count > 1 && !args.replace_all) return err(`old_string apparaît ${count} fois. Ajoute du contexte autour ou passe replace_all=true.`);
        const next = args.replace_all ? src.split(needle).join(norm(newS)) : src.replace(needle, () => norm(newS));
        fs.writeFileSync(abs, next);
        ctx.onFileChanged(abs);
        return ok(`Modifié : ${args.path} (${args.replace_all ? count : 1} remplacement${count > 1 && args.replace_all ? "s" : ""})`);
      }
      case "search_files": {
        const start = resolveIn(ctx.workspace, args.path ?? ".");
        let re: RegExp;
        try {
          re = new RegExp(String(args.pattern), "i");
        } catch (e) {
          return err(`Regex invalide : ${(e as Error).message}`);
        }
        const hits: string[] = [];
        for (const rel of iterFiles(start)) {
          if (hits.length >= 200) break;
          if (args.files_only) {
            if (re.test(rel)) hits.push(rel);
            continue;
          }
          const full = path.join(start, rel);
          let buf: Buffer;
          try {
            if (fs.statSync(full).size > 1024 * 1024) continue;
            buf = fs.readFileSync(full);
          } catch {
            continue;
          }
          if (isBinary(buf)) continue;
          const lines = buf.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < 200; i++) {
            if (re.test(lines[i])) hits.push(`${rel}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
          }
        }
        return ok(hits.length ? hits.join("\n") + (hits.length >= 200 ? "\n… (limite de 200 atteinte)" : "") : "Aucun résultat.");
      }
      case "run_command": {
        const cwd = resolveIn(ctx.workspace, args.cwd ?? ".");
        const timeoutMs = Math.min(Math.max(Number(args.timeout_sec) || 120, 1), 600) * 1000;
        const r = await runCommand({ command: String(args.command), cwd, timeoutMs, signal: ctx.signal, onData: ctx.onTerminal });
        const head = r.timedOut ? `[délai de ${timeoutMs / 1000} s dépassé, processus arrêté]` : r.aborted ? "[interrompu]" : `[code de sortie ${r.code}]`;
        return { content: `${head}\n${r.output || "(aucune sortie)"}`, isError: r.code !== 0 || r.timedOut };
      }

      // ── n8n ──
      case "n8n_list_workflows":
        return ok(JSON.stringify(await n8n.listWorkflows(), null, 1));
      case "n8n_get_workflow":
        return ok(JSON.stringify(await n8n.getWorkflow(String(args.id))));
      case "n8n_create_workflow": {
        const w: any = await n8n.createWorkflow(args.workflow);
        return ok(`Workflow créé (inactif) : id=${w.id}, nom="${w.name}". Ouvre-le dans n8n pour associer les identifiants (credentials) manquants.`);
      }
      case "n8n_update_workflow": {
        const w: any = await n8n.updateWorkflow(String(args.id), args.workflow);
        return ok(`Workflow mis à jour : id=${w.id}, nom="${w.name}", actif=${!!w.active}.`);
      }
      case "n8n_set_active": {
        const w: any = await n8n.setActive(String(args.id), !!args.active);
        return ok(`Workflow ${w.id} : actif=${!!w.active}.`);
      }
      case "n8n_delete_workflow":
        await n8n.deleteWorkflow(String(args.id));
        return ok(`Workflow ${args.id} supprimé.`);
      case "n8n_list_executions":
        return ok(JSON.stringify(await n8n.listExecutions(args.workflow_id, args.status, Math.min(Number(args.limit) || 10, 50)), null, 1));
      case "n8n_get_execution": {
        const s = JSON.stringify(await n8n.getExecution(String(args.id)));
        return ok(s.length > 30000 ? `${s.slice(0, 30000)}… [tronqué]` : s);
      }
      case "n8n_call_webhook":
        return ok(JSON.stringify(await n8n.callWebhook(String(args.path), String(args.method ?? "POST").toUpperCase(), args.body, !!args.test)));
      default:
        return err(`Outil inconnu : ${name}`);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return err(`Introuvable : ${args.path ?? args.cwd ?? ""}`);
    return err((e as Error).message);
  }
}
