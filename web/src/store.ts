import { create } from "zustand";
import { api, connectWs, wsSend, type AppState, type ChatMeta, type Entry, type ModelList, type ProviderId, type Workflow } from "./api";
import { startRecording, type Recording } from "./voice";
import { ensureModel, getValue, languageFor, setValue, disposeModel, getSelectionText, revealLine } from "./monaco";
import { writeTerminal, writePrompt, notifyExit, setCwdProvider } from "./terminal-bus";

export interface Tab {
  id: string;
  kind: "file" | "n8n";
  path: string;
  title: string;
  dirty: boolean;
  loading: boolean;
  note?: string;
  n8nId?: string;
}

export type Item =
  | { kind: "user"; text: string; file?: string; sel?: boolean }
  | { kind: "assistant"; text: string; thinking: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; args: Record<string, any>; status: "running" | "waiting" | "done" | "error"; result?: string }
  | { kind: "approval"; id: string; tool: string; title: string; detail: string; state: "pending" | "allowed" | "denied" }
  | { kind: "error"; text: string };

/** Nombre de conversations côte à côte. */
export const PANES = 4;

export interface Pane {
  chatId: string;
  title: string;
  items: Item[];
  running: boolean;
  usage: { input: number; output: number };
  draft: string;
  /** Modèle propre à cette conversation ; null = celui des réglages. */
  model: { provider: ProviderId; id: string } | null;
  voice: "idle" | "rec" | "busy";
  /** Dictée envoyée pendant que l'agent travaille : part toute seule dès qu'il a fini. */
  sendWhenIdle: boolean;
}

interface S {
  app: AppState | null;
  online: boolean;
  models: Record<string, ModelList>;
  dirs: Record<string, Entry[]>;
  expanded: Record<string, boolean>;
  allFiles: string[];
  tabs: Tab[];
  active: string | null;
  sidebarTab: "files" | "n8n";
  /** « Mode code » : barre latérale + éditeur (+ terminal) à gauche des conversations. */
  show: { code: boolean; term: boolean };
  settings: false | "providers" | "n8n" | "agent" | "voice" | "appearance";
  palette: null | "files" | "cmd";
  toast: string;
  panes: Pane[];
  focused: number;
  chats: ChatMeta[];
  includeActive: boolean;
  workflows: Workflow[];
  n8nError: string;
  termCwd: string;

  init(): Promise<void>;
  refreshApp(): Promise<void>;
  loadModels(): Promise<void>;
  setApp(a: AppState): void;
  toggle(k: "code" | "term"): void;
  say(msg: string): void;

  loadDir(p: string): Promise<void>;
  toggleDir(p: string): Promise<void>;
  loadAllFiles(): Promise<void>;
  openFile(p: string, line?: number): Promise<void>;
  openN8n(id: string): Promise<void>;
  closeTab(id: string): void;
  saveTab(id?: string): Promise<void>;
  markDirty(id: string, dirty: boolean): void;
  activate(id: string): void;

  openFolder(p: string): Promise<void>;
  pickFolder(): Promise<void>;
  refreshWorkflows(): Promise<void>;

  sendChat(i: number, text: string): void;
  stop(i: number): void;
  newChat(i: number): void;
  loadChat(i: number, id: string): Promise<boolean>;
  refreshChats(): Promise<void>;
  decide(id: string, allow: boolean): void;
  setDraft(i: number, text: string): void;
  setPaneModel(i: number, provider: ProviderId, id: string): void;
  toggleMic(i: number): Promise<void>;
  refreshVoice(): Promise<void>;
  patchSettings(p: Record<string, unknown>): Promise<void>;
}

const uuid = () => crypto.randomUUID();

const blankPane = (): Pane => ({
  chatId: uuid(), title: "Nouvelle conversation", items: [], running: false, usage: { input: 0, output: 0 },
  draft: "", model: null, voice: "idle", sendWhenIdle: false,
});

// Les quatre fenêtres de chat survivent à un rechargement : on retient leur conversation et leur modèle.
const PANES_KEY = "cv.panes";
const readSavedPanes = (): { id?: string; model?: Pane["model"] }[] => {
  try { const v = JSON.parse(localStorage.getItem(PANES_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
};
const savePanes = (panes: Pane[]) => {
  try { localStorage.setItem(PANES_KEY, JSON.stringify(panes.map((p) => ({ id: p.items.length ? p.chatId : undefined, model: p.model })))); } catch { /* stockage indisponible */ }
};

// Regroupe les deltas de texte pour ne rendre qu'une fois par image, séparément pour chaque fenêtre.
const bufs = Array.from({ length: PANES }, () => ({ text: "", think: "", raf: 0 }));
let agentUsedTerminal = false;

// Un seul micro à la fois ; le niveau sonore est diffusé aux boutons sans passer par le store (125 mises à jour/s).
let rec: { pane: number; r: Recording } | null = null;
const levelListeners = new Set<(pane: number, level: number) => void>();
export const onMicLevel = (cb: (pane: number, level: number) => void) => { levelListeners.add(cb); return () => void levelListeners.delete(cb); };

const micError = (e: unknown) => {
  const name = (e as Error)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Micro refusé — autorise-le (icône à gauche de la barre d'adresse) puis réessaie.";
  if (name === "NotFoundError") return "Aucun micro détecté.";
  return `Micro indisponible : ${(e as Error)?.message ?? e}`;
};

export const useStore = create<S>((set, get) => {
  const setPane = (i: number, patch: Partial<Pane> | ((p: Pane) => Partial<Pane>)) =>
    set((s) => {
      if (!s.panes[i]) return s;
      const panes = s.panes.slice();
      panes[i] = { ...panes[i], ...(typeof patch === "function" ? patch(panes[i]) : patch) };
      return { panes };
    });
  const paneOf = (chatId: string) => get().panes.findIndex((p) => p.chatId === chatId);

  const flush = (i: number) => {
    const b = bufs[i];
    b.raf = 0;
    if (!b.text && !b.think) return;
    const t = b.text, k = b.think;
    b.text = b.think = "";
    setPane(i, (p) => {
      const items = p.items.slice();
      let last = items[items.length - 1];
      if (!last || last.kind !== "assistant" || !last.streaming) {
        last = { kind: "assistant", text: "", thinking: "", streaming: true };
        items.push(last);
      }
      items[items.length - 1] = { ...last, text: last.text + t, thinking: (last.thinking + k).slice(-600) };
      return { items };
    });
  };
  const schedule = (i: number) => { if (!bufs[i].raf) bufs[i].raf = requestAnimationFrame(() => flush(i)); };
  const endStream = (i: number) => {
    if (bufs[i].raf) { cancelAnimationFrame(bufs[i].raf); bufs[i].raf = 0; }
    flush(i);
    setPane(i, (p) => ({ items: p.items.map((it) => (it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it)) }));
  };
  const patchItem = (i: number, match: (it: Item) => boolean, fn: (it: any) => Item) =>
    setPane(i, (p) => {
      const idx = p.items.findIndex(match);
      if (idx < 0) return {};
      const items = p.items.slice();
      items[idx] = fn(items[idx]);
      return { items };
    });

  const onEvent = (chatId: string, e: any) => {
    const i = paneOf(chatId);
    if (i < 0) return;
    switch (e.type) {
      case "text": bufs[i].text += e.delta; schedule(i); break;
      case "thinking": bufs[i].think += e.delta; schedule(i); break;
      case "tool_start":
        endStream(i);
        setPane(i, (p) => ({ items: [...p.items, { kind: "tool", id: e.id, name: e.name, args: e.args, status: "running" }] }));
        if (e.name === "run_command") {
          writeTerminal(`\r\n\x1b[38;5;78m● agent ${i + 1}\x1b[0m \x1b[2m$\x1b[0m ${String(e.args.command ?? "").replace(/\r?\n/g, "\r\n  ")}\r\n`);
          agentUsedTerminal = true;
        }
        break;
      case "approval":
        endStream(i);
        setPane(i, (p) => ({ items: [...p.items, { kind: "approval", id: e.id, tool: e.tool, title: e.title, detail: e.detail, state: "pending" }] }));
        break;
      case "tool_result":
        patchItem(i, (it) => it.kind === "tool" && it.id === e.id, (it) => ({ ...it, status: e.isError ? "error" : "done", result: e.content }));
        if (!e.isError) {
          const it = get().panes[i].items.find((x) => x.kind === "tool" && x.id === e.id) as Extract<Item, { kind: "tool" }> | undefined;
          // L'éditeur ne s'ouvre tout seul que si le mode code est affiché.
          if (get().show.code && it && (it.name === "write_file" || it.name === "edit_file") && typeof it.args.path === "string") void get().openFile(it.args.path.replace(/\\/g, "/"));
          if (it?.name.startsWith("n8n_")) void get().refreshWorkflows();
        }
        break;
      case "usage": setPane(i, (p) => ({ usage: { input: p.usage.input + e.input, output: p.usage.output + e.output } })); break;
      case "title": setPane(i, { title: e.title }); break;
      case "error": endStream(i); setPane(i, (p) => ({ items: [...p.items, { kind: "error", text: e.message }] })); break;
      case "done": {
        endStream(i);
        setPane(i, (p) => ({
          running: false,
          items: p.items.map((it) => (it.kind === "tool" && (it.status === "running" || it.status === "waiting") ? { ...it, status: "error" as const } : it.kind === "approval" && it.state === "pending" ? { ...it, state: "denied" as const } : it)),
        }));
        if (agentUsedTerminal) { agentUsedTerminal = false; writePrompt(); }
        void get().refreshChats();
        const p = get().panes[i];
        if (p.sendWhenIdle) {
          setPane(i, { sendWhenIdle: false });
          if (p.draft.trim()) get().sendChat(i, p.draft);
        }
        break;
      }
    }
  };

  const reloadOpenFile = async (path: string) => {
    const tab = get().tabs.find((t) => t.kind === "file" && t.path === path);
    if (!tab || tab.dirty) return;
    try {
      const r = await api("GET", `/api/fs/file?path=${encodeURIComponent(path)}`);
      if (typeof r.content === "string") setValue(tab.id, r.content);
    } catch { /* supprimé entre-temps */ }
  };

  const onMessage = (m: any) => {
    switch (m.type) {
      case "chat.event": onEvent(m.chatId, m.event); break;
      case "term.data": writeTerminal(String(m.data).replace(/\r?\n/g, "\r\n")); break;
      case "term.exit": if (m.cwd) set({ termCwd: m.cwd }); notifyExit(); writePrompt(); break;
      case "fs.changed": {
        const dirs = new Set<string>([""]);
        for (const p of m.paths as string[]) {
          const parent = p.split("/").slice(0, -1).join("/");
          dirs.add(parent);
          void reloadOpenFile(p);
        }
        for (const d of dirs) if (d === "" || get().dirs[d]) void get().loadDir(d);
        if (get().allFiles.length) void get().loadAllFiles();
        break;
      }
    }
  };

  /** Termine la dictée de la fenêtre i, transcrit, puis dépose le texte dans sa zone de saisie. */
  const finishMic = async (i: number) => {
    const cur = rec;
    if (!cur || cur.pane !== i) return;
    rec = null;
    setPane(i, { voice: "busy" });
    try {
      const { wav } = await cur.r.finish();
      if (!wav) return get().say("Rien entendu.");
      const lang = get().app?.settings.voiceLang ?? "fr";
      const res = await fetch(`/api/voice/transcribe?lang=${encodeURIComponent(lang)}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      const text = String(data.text ?? "").trim();
      if (!text) return get().say("Rien compris — réessaie.");
      setPane(i, (p) => ({ draft: p.draft.trim() ? `${p.draft.trim()} ${text}` : text }));
      if (get().app?.settings.voiceAutoSend) {
        if (get().panes[i].running) setPane(i, { sendWhenIdle: true });
        else get().sendChat(i, get().panes[i].draft);
      } else document.getElementById(`composer-${i}`)?.focus();
    } catch (e) {
      get().say(`Voix : ${(e as Error).message}`);
    } finally {
      setPane(i, { voice: "idle" });
    }
  };

  return {
    app: null, online: false, models: {}, dirs: {}, expanded: {}, allFiles: [], tabs: [], active: null,
    sidebarTab: "files",
    show: { code: false, term: false },
    settings: false, palette: null, toast: "",
    panes: Array.from({ length: PANES }, blankPane), focused: 0, chats: [],
    includeActive: true, workflows: [], n8nError: "", termCwd: "",

    async init() {
      setCwdProvider(() => get().termCwd);
      connectWs(onMessage, (up) => set({ online: up }));
      await get().refreshApp();
      void get().loadModels();
      void get().refreshChats();
      const a = get().app!;
      if (a.settings.workspace) { await get().loadDir(""); set({ termCwd: a.settings.workspace }); }
      if (a.n8n.configured) void get().refreshWorkflows();
      // Retrouve les quatre conversations de la dernière séance.
      const saved = readSavedPanes();
      await Promise.all(Array.from({ length: PANES }, async (_, i) => {
        const sv = saved[i];
        if (sv?.model) setPane(i, { model: sv.model });
        if (sv?.id) await get().loadChat(i, sv.id).catch(() => false);
      }));
      void get().refreshVoice();
    },
    async refreshApp() { set({ app: await api("GET", "/api/state") }); },
    setApp(app) { set({ app }); },
    async loadModels() { try { set({ models: await api("GET", "/api/models") }); } catch { /* hors-ligne */ } },
    toggle(k) {
      set((s) => {
        const show = { ...s.show, [k]: !s.show[k] };
        if (k === "term" && show.term) show.code = true; // le terminal vit dans le mode code
        if (k === "code" && !show.code) show.term = false;
        return { show };
      });
    },
    say(toast) { set({ toast }); setTimeout(() => get().toast === toast && set({ toast: "" }), 2600); },

    async loadDir(p) {
      try {
        const r = await api<{ entries: Entry[] }>("GET", `/api/fs/dir?path=${encodeURIComponent(p)}`);
        set((s) => ({ dirs: { ...s.dirs, [p]: r.entries } }));
      } catch { /* dossier disparu */ }
    },
    async toggleDir(p) {
      const open = !get().expanded[p];
      set((s) => ({ expanded: { ...s.expanded, [p]: open } }));
      if (open && !get().dirs[p]) await get().loadDir(p);
    },
    async loadAllFiles() {
      try { set({ allFiles: (await api<{ files: string[] }>("GET", "/api/fs/files")).files }); } catch { /* aucun dossier */ }
    },

    async openFile(p, line) {
      const id = `file:${p}`;
      if (!get().show.code) set((s) => ({ show: { ...s.show, code: true } }));
      const existing = get().tabs.find((t) => t.id === id);
      if (existing) { set({ active: id }); if (line) setTimeout(() => revealLine(line), 60); return; }
      const title = p.split("/").pop()!;
      set((s) => ({ tabs: [...s.tabs, { id, kind: "file", path: p, title, dirty: false, loading: true }], active: id }));
      try {
        const r = await api("GET", `/api/fs/file?path=${encodeURIComponent(p)}`);
        if (r.binary || r.tooLarge) {
          set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, loading: false, note: r.binary ? "Fichier binaire — aperçu indisponible." : "Fichier trop volumineux (> 3 Mo)." } : t)) }));
          return;
        }
        ensureModel(id, r.content, languageFor(p));
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, loading: false } : t)) }));
        if (line) setTimeout(() => revealLine(line), 120);
      } catch (e) {
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, loading: false, note: (e as Error).message } : t)) }));
      }
    },

    async openN8n(wid) {
      const id = `n8n:${wid}`;
      if (!get().show.code) set((s) => ({ show: { ...s.show, code: true } }));
      if (get().tabs.some((t) => t.id === id)) return set({ active: id });
      const wf = get().workflows.find((w) => w.id === wid);
      set((s) => ({ tabs: [...s.tabs, { id, kind: "n8n", path: wf?.name ?? wid, title: `${wf?.name ?? wid}.n8n.json`, dirty: false, loading: true, n8nId: wid }], active: id }));
      try {
        const w = await api("GET", `/api/n8n/workflows/${encodeURIComponent(wid)}`);
        ensureModel(id, JSON.stringify(w, null, 2), "json");
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, loading: false, title: `${w.name}.n8n.json`, path: w.name } : t)) }));
      } catch (e) {
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, loading: false, note: (e as Error).message } : t)) }));
      }
    },

    closeTab(id) {
      const { tabs, active } = get();
      const t = tabs.find((x) => x.id === id);
      if (t?.dirty && !confirm(`« ${t.title} » a des modifications non enregistrées. Fermer quand même ?`)) return;
      const i = tabs.findIndex((x) => x.id === id);
      const rest = tabs.filter((x) => x.id !== id);
      disposeModel(id);
      set({ tabs: rest, active: active === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : active });
    },

    async saveTab(id) {
      const tab = get().tabs.find((t) => t.id === (id ?? get().active));
      if (!tab) return;
      const content = getValue(tab.id);
      if (content === undefined) return;
      try {
        if (tab.kind === "file") await api("PUT", "/api/fs/file", { path: tab.path, content });
        else {
          let body: unknown;
          try { body = JSON.parse(content); } catch (e) { return get().say(`JSON invalide : ${(e as Error).message}`); }
          await api("PUT", `/api/n8n/workflows/${encodeURIComponent(tab.n8nId!)}`, body);
          void get().refreshWorkflows();
        }
        get().markDirty(tab.id, false);
        get().say(tab.kind === "n8n" ? "Workflow envoyé à n8n" : `Enregistré : ${tab.title}`);
      } catch (e) { get().say(`Échec : ${(e as Error).message}`); }
    },

    markDirty(id, dirty) {
      set((s) => (s.tabs.find((t) => t.id === id)?.dirty === dirty ? s : { tabs: s.tabs.map((t) => (t.id === id ? { ...t, dirty } : t)) }));
    },
    activate(id) { set({ active: id }); },

    async openFolder(p) {
      try {
        const app = await api<AppState>("POST", "/api/workspace", { path: p });
        for (const t of get().tabs) disposeModel(t.id);
        set({ app, tabs: [], active: null, dirs: {}, expanded: {}, allFiles: [], termCwd: app.settings.workspace ?? "" });
        await get().loadDir("");
        for (let i = 0; i < PANES; i++) get().newChat(i);
        wsSend({ type: "term_cwd" });
      } catch (e) { get().say((e as Error).message); }
    },
    async pickFolder() {
      try {
        const { path } = await api<{ path: string | null }>("POST", "/api/workspace/pick");
        if (path) await get().openFolder(path);
      } catch (e) { get().say((e as Error).message); }
    },
    async refreshWorkflows() {
      if (!get().app?.n8n.configured) return set({ workflows: [], n8nError: "" });
      try { set({ workflows: await api("GET", "/api/n8n/workflows"), n8nError: "" }); } catch (e) { set({ n8nError: (e as Error).message }); }
    },

    sendChat(i, text) {
      const s = get();
      const p = s.panes[i];
      if (!p || p.running || !text.trim()) return;
      const model = p.model ?? s.app?.settings.model ?? null;
      if (!model) return get().say("Choisis d'abord un modèle (en bas de la conversation).");
      // Le fichier ouvert dans l'éditeur n'est joint que si le mode code est affiché : sinon il est invisible pour l'utilisateur.
      const activeTab = s.show.code ? s.tabs.find((t) => t.id === s.active && t.kind === "file") : undefined;
      const sel = activeTab ? getSelectionText() : "";
      const file = s.includeActive && activeTab ? activeTab.path : undefined;
      setPane(i, (q) => ({ items: [...q.items, { kind: "user", text, file, sel: !!sel && !!file }], running: true, draft: "", model, sendWhenIdle: false }));
      savePanes(get().panes);
      if (!wsSend({ type: "chat", chatId: p.chatId, text, model, context: file ? { file, selection: sel || undefined } : undefined })) {
        setPane(i, (q) => ({ running: false, items: [...q.items, { kind: "error", text: "Connexion au serveur perdue — reconnexion en cours…" }] }));
      }
    },
    stop(i) {
      setPane(i, { sendWhenIdle: false });
      wsSend({ type: "stop", chatId: get().panes[i].chatId });
    },
    newChat(i) {
      const old = get().panes[i];
      if (!old) return;
      if (old.running) get().stop(i);
      if (rec?.pane === i) { rec.r.cancel(); rec = null; }
      setPane(i, { ...blankPane(), model: old.model });
      savePanes(get().panes);
    },
    async loadChat(i, id) {
      const elsewhere = get().panes.findIndex((p, k) => k !== i && p.chatId === id);
      if (elsewhere >= 0) { get().say(`Cette conversation est déjà ouverte dans la fenêtre ${elsewhere + 1}.`); return false; }
      if (get().panes[i].running) get().stop(i);
      let c: any;
      try { c = await api("GET", `/api/chats/${id}`); } catch { return false; }
      const items: Item[] = [];
      const byId = new Map<string, Extract<Item, { kind: "tool" }>>();
      for (const m of c.messages as any[]) {
        if (m.role === "user") {
          if (m.auto) continue;
          const text = String(m.content).replace(/\n\n<(?:file|selection) [\s\S]*$/, "").replace(/^\[Fichier ouvert dans l'éditeur : [^\]]*\]\n/, "");
          items.push({ kind: "user", text });
        } else if (m.role === "assistant") {
          if (m.content) items.push({ kind: "assistant", text: m.content, thinking: "", streaming: false });
          for (const tc of m.toolCalls ?? []) {
            const it = { kind: "tool" as const, id: tc.id, name: tc.name, args: tc.args, status: "done" as const };
            byId.set(tc.id, it);
            items.push(it);
          }
        } else {
          const it = byId.get(m.toolCallId);
          if (it) { it.result = m.content; if (m.isError) (it as any).status = "error"; }
        }
      }
      setPane(i, { chatId: id, title: c.title, items: items.map((x) => ({ ...x })), usage: { input: 0, output: 0 }, running: false, draft: "" });
      savePanes(get().panes);
      return true;
    },
    async refreshChats() { try { set({ chats: await api("GET", "/api/chats") }); } catch { /* ignoré */ } },
    decide(id, allow) {
      wsSend({ type: "approve", id, allow });
      get().panes.forEach((_, i) => patchItem(i, (it) => it.kind === "approval" && it.id === id, (it) => ({ ...it, state: allow ? "allowed" : "denied" })));
    },
    setDraft(i, text) { setPane(i, { draft: text }); },
    setPaneModel(i, provider, id) {
      setPane(i, { model: { provider, id } });
      savePanes(get().panes);
    },

    async toggleMic(i) {
      const s = get();
      if (!s.app?.voice.installed) return get().say("La voix n'est pas installée — lance « npm run voice:install » (ou Installer-voix.bat), puis relance CodeView.");
      if (s.panes[i].voice === "busy") return;
      if (rec?.pane === i) return void finishMic(i);
      if (rec) await finishMic(rec.pane); // un seul micro à la fois : on boucle d'abord l'autre fenêtre
      try {
        const r = await startRecording({ onLevel: (l) => levelListeners.forEach((f) => f(i, l)), onAutoStop: () => void finishMic(i) });
        rec = { pane: i, r };
        setPane(i, { voice: "rec" });
        set({ focused: i });
      } catch (e) { get().say(micError(e)); }
    },
    async refreshVoice() {
      try {
        const voice = await api<AppState["voice"]>("GET", "/api/voice/status");
        set((s) => (s.app ? { app: { ...s.app, voice } } : s));
        if (voice.state === "loading") setTimeout(() => void get().refreshVoice(), 2000); // le premier lancement peut télécharger le modèle
      } catch { /* hors-ligne */ }
    },
    async patchSettings(p) {
      set({ app: await api("PUT", "/api/settings", p) });
      if ("voiceModel" in p) setTimeout(() => void get().refreshVoice(), 500);
    },
  };
});
