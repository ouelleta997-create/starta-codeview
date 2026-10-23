import { create } from "zustand";
import { api, connectWs, wsSend, type AppState, type ChatMeta, type Entry, type ModelList, type ProviderId, type Workflow } from "./api";
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
  show: { sidebar: boolean; agent: boolean; term: boolean };
  settings: false | "providers" | "n8n" | "agent" | "appearance";
  palette: null | "files" | "cmd";
  toast: string;
  chatId: string;
  chatTitle: string;
  items: Item[];
  running: boolean;
  usage: { input: number; output: number };
  chats: ChatMeta[];
  includeActive: boolean;
  draft: string;
  workflows: Workflow[];
  n8nError: string;
  termCwd: string;

  init(): Promise<void>;
  refreshApp(): Promise<void>;
  loadModels(): Promise<void>;
  setApp(a: AppState): void;
  toggle(k: "sidebar" | "agent" | "term"): void;
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

  sendChat(text: string): void;
  stop(): void;
  newChat(): void;
  loadChat(id: string): Promise<void>;
  refreshChats(): Promise<void>;
  decide(id: string, allow: boolean): void;
  setModel(provider: ProviderId, id: string): Promise<void>;
  patchSettings(p: Record<string, unknown>): Promise<void>;
}

const uuid = () => crypto.randomUUID();

// Regroupe les deltas de texte pour ne rendre qu'une fois par image.
let pendingText = "";
let pendingThink = "";
let raf = 0;
let agentUsedTerminal = false;

export const useStore = create<S>((set, get) => {
  const flush = () => {
    raf = 0;
    if (!pendingText && !pendingThink) return;
    const t = pendingText, k = pendingThink;
    pendingText = pendingThink = "";
    set((s) => {
      const items = s.items.slice();
      let last = items[items.length - 1];
      if (!last || last.kind !== "assistant" || !last.streaming) {
        last = { kind: "assistant", text: "", thinking: "", streaming: true };
        items.push(last);
      }
      items[items.length - 1] = { ...last, text: last.text + t, thinking: (last.thinking + k).slice(-600) };
      return { items };
    });
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(flush); };
  const endStream = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    flush();
    set((s) => ({ items: s.items.map((i) => (i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i)) }));
  };
  const patchItem = (match: (i: Item) => boolean, fn: (i: any) => Item) =>
    set((s) => {
      const idx = s.items.findIndex(match);
      if (idx < 0) return s;
      const items = s.items.slice();
      items[idx] = fn(items[idx]);
      return { items };
    });

  const onEvent = (chatId: string, e: any) => {
    if (chatId !== get().chatId) return;
    switch (e.type) {
      case "text": pendingText += e.delta; schedule(); break;
      case "thinking": pendingThink += e.delta; schedule(); break;
      case "tool_start":
        endStream();
        set((s) => ({ items: [...s.items, { kind: "tool", id: e.id, name: e.name, args: e.args, status: "running" }] }));
        if (e.name === "run_command") {
          writeTerminal(`\r\n\x1b[38;5;78m● agent\x1b[0m \x1b[2m$\x1b[0m ${String(e.args.command ?? "").replace(/\r?\n/g, "\r\n  ")}\r\n`);
          agentUsedTerminal = true;
          set((s) => ({ show: { ...s.show, term: true } }));
        }
        break;
      case "approval":
        endStream();
        set((s) => ({ items: [...s.items, { kind: "approval", id: e.id, tool: e.tool, title: e.title, detail: e.detail, state: "pending" }] }));
        break;
      case "tool_result":
        patchItem((i) => i.kind === "tool" && i.id === e.id, (i) => ({ ...i, status: e.isError ? "error" : "done", result: e.content }));
        if (!e.isError) {
          const it = get().items.find((i) => i.kind === "tool" && i.id === e.id) as Extract<Item, { kind: "tool" }> | undefined;
          if (it && (it.name === "write_file" || it.name === "edit_file") && typeof it.args.path === "string") void get().openFile(it.args.path.replace(/\\/g, "/"));
          if (it?.name.startsWith("n8n_")) void get().refreshWorkflows();
        }
        break;
      case "usage": set((s) => ({ usage: { input: s.usage.input + e.input, output: s.usage.output + e.output } })); break;
      case "title": set({ chatTitle: e.title }); break;
      case "error": endStream(); set((s) => ({ items: [...s.items, { kind: "error", text: e.message }] })); break;
      case "done":
        endStream();
        set({ running: false });
        set((s) => ({ items: s.items.map((i) => (i.kind === "tool" && (i.status === "running" || i.status === "waiting") ? { ...i, status: "error" as const } : i.kind === "approval" && i.state === "pending" ? { ...i, state: "denied" as const } : i)) }));
        if (agentUsedTerminal) { agentUsedTerminal = false; writePrompt(); }
        void get().refreshChats();
        break;
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

  return {
    app: null, online: false, models: {}, dirs: {}, expanded: {}, allFiles: [], tabs: [], active: null,
    sidebarTab: "files",
    show: { sidebar: true, agent: true, term: false },
    settings: false, palette: null, toast: "",
    chatId: uuid(), chatTitle: "Nouvelle conversation", items: [], running: false, usage: { input: 0, output: 0 }, chats: [],
    includeActive: true, draft: "", workflows: [], n8nError: "", termCwd: "",

    async init() {
      setCwdProvider(() => get().termCwd);
      connectWs(onMessage, (up) => set({ online: up }));
      await get().refreshApp();
      void get().loadModels();
      void get().refreshChats();
      const a = get().app!;
      if (a.settings.workspace) { await get().loadDir(""); set({ termCwd: a.settings.workspace }); }
      if (a.n8n.configured) void get().refreshWorkflows();
    },
    async refreshApp() { set({ app: await api("GET", "/api/state") }); },
    setApp(app) { set({ app }); },
    async loadModels() { try { set({ models: await api("GET", "/api/models") }); } catch { /* hors-ligne */ } },
    toggle(k) { set((s) => ({ show: { ...s.show, [k]: !s.show[k] } })); },
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
        get().newChat();
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

    sendChat(text) {
      const s = get();
      if (s.running || !text.trim()) return;
      const activeTab = s.tabs.find((t) => t.id === s.active && t.kind === "file");
      const sel = getSelectionText();
      const file = s.includeActive && activeTab ? activeTab.path : undefined;
      const model = s.app?.settings.model;
      set((st) => ({ items: [...st.items, { kind: "user", text, file, sel: !!sel && !!file }], running: true, draft: "" }));
      if (!wsSend({ type: "chat", chatId: s.chatId, text, model, context: file ? { file, selection: sel || undefined } : undefined })) {
        set((st) => ({ running: false, items: [...st.items, { kind: "error", text: "Connexion au serveur perdue — reconnexion en cours…" }] }));
      }
    },
    stop() { wsSend({ type: "stop", chatId: get().chatId }); },
    newChat() {
      if (get().running) get().stop();
      set({ chatId: uuid(), chatTitle: "Nouvelle conversation", items: [], usage: { input: 0, output: 0 }, running: false });
    },
    async loadChat(id) {
      if (get().running) get().stop();
      const c = await api("GET", `/api/chats/${id}`);
      const items: Item[] = [];
      const byId = new Map<string, Extract<Item, { kind: "tool" }>>();
      for (const m of c.messages as any[]) {
        if (m.role === "user") {
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
      set({ chatId: id, chatTitle: c.title, items: items.map((i) => ({ ...i })), usage: { input: 0, output: 0 } });
    },
    async refreshChats() { try { set({ chats: await api("GET", "/api/chats") }); } catch { /* ignoré */ } },
    decide(id, allow) {
      wsSend({ type: "approve", id, allow });
      patchItem((i) => i.kind === "approval" && i.id === id, (i) => ({ ...i, state: allow ? "allowed" : "denied" }));
    },
    async setModel(provider, id) {
      await get().patchSettings({ model: { provider, id } });
    },
    async patchSettings(p) { set({ app: await api("PUT", "/api/settings", p) }); },
  };
});
