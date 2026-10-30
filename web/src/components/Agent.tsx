import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp, Square, Plus, History, Check, X, Loader2, Hourglass, ShieldAlert, AlertTriangle, ChevronDown, ChevronRight, Search as SearchIcon,
  FolderTree, FileText, FilePlus2, Pencil, TerminalSquare, Workflow, Sparkles, Bug, FlaskConical, BookOpen, Trash2, KeyRound, Mic,
} from "lucide-react";
import { useStore, onMicLevel, type Item } from "../store";
import { PROVIDER_ORDER, type ProviderId } from "../api";
import { renderMarkdown } from "../markdown";
import { monaco, themeName, resolveLang } from "../monaco";
import { Dropdown, FileIcon } from "./ui";

// ───────────────────────── Markdown ─────────────────────────

function Md({ text, streaming }: { text: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  useEffect(() => {
    if (streaming || !ref.current) return;
    const theme = themeName((document.documentElement.dataset.theme as "dark" | "light") ?? "dark");
    ref.current.querySelectorAll<HTMLElement>("code[data-lang]").forEach((el) => {
      const lang = resolveLang(el.dataset.lang ?? "");
      if (!lang) return;
      el.dataset.lang = lang;
      void monaco.editor.colorizeElement(el, { theme, tabSize: 2 }).catch(() => {});
    });
  }, [html, streaming]);
  return (
    <div
      ref={ref}
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const btn = (e.target as HTMLElement).closest("[data-copy]");
        if (!btn) return;
        const code = btn.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
        void navigator.clipboard.writeText(code);
        btn.textContent = "Copié ✓";
        setTimeout(() => (btn.textContent = "Copier"), 1400);
      }}
    />
  );
}

// ───────────────────────── Cartes d'outils ─────────────────────────

const TOOL_META: Record<string, { icon: typeof FileText; label: string; arg: (a: any) => string }> = {
  list_dir: { icon: FolderTree, label: "Liste", arg: (a) => a.path || "." },
  read_file: { icon: FileText, label: "Lit", arg: (a) => `${a.path}${a.start_line ? `:${a.start_line}-${a.end_line ?? ""}` : ""}` },
  write_file: { icon: FilePlus2, label: "Écrit", arg: (a) => a.path },
  edit_file: { icon: Pencil, label: "Modifie", arg: (a) => a.path },
  search_files: { icon: SearchIcon, label: "Cherche", arg: (a) => a.pattern },
  run_command: { icon: TerminalSquare, label: "Exécute", arg: (a) => a.command },
};

function N8nLabel(name: string) {
  const map: Record<string, string> = {
    n8n_list_workflows: "Liste les workflows", n8n_get_workflow: "Lit un workflow", n8n_create_workflow: "Crée un workflow", n8n_update_workflow: "Met à jour un workflow",
    n8n_set_active: "Active / désactive", n8n_delete_workflow: "Supprime un workflow", n8n_list_executions: "Liste les exécutions", n8n_get_execution: "Lit une exécution", n8n_call_webhook: "Appelle un webhook",
  };
  return map[name] ?? name;
}

function lineDiff(oldS: string, newS: string) {
  return (
    <div className="diff">
      {oldS.split("\n").slice(0, 60).map((l, i) => <div key={`d${i}`} className="d">− {l}</div>)}
      {newS.split("\n").slice(0, 60).map((l, i) => <div key={`a${i}`} className="a">+ {l}</div>)}
    </div>
  );
}

function ToolCard({ it }: { it: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(it.name === "edit_file" || it.name === "write_file");
  const isN8n = it.name.startsWith("n8n_");
  const meta = TOOL_META[it.name];
  const Icon = isN8n ? Workflow : meta?.icon ?? Sparkles;
  const arg = isN8n ? String(it.args.name ?? it.args.workflow?.name ?? it.args.id ?? it.args.path ?? "") : meta?.arg(it.args) ?? "";
  const filePath = ["read_file", "write_file", "edit_file"].includes(it.name) ? String(it.args.path ?? "") : "";
  const st = it.status === "running" ? <Loader2 className="spin" /> : it.status === "waiting" ? <Hourglass className="wait" /> : it.status === "done" ? <Check className="ok" /> : <X className="bad" />;

  let body: React.ReactNode = null;
  if (open) {
    if (it.name === "edit_file") body = <>{lineDiff(String(it.args.old_string ?? ""), String(it.args.new_string ?? ""))}{it.status === "error" && it.result && <pre className="bad">{it.result}</pre>}</>;
    else if (it.name === "write_file") body = <div className="diff">{String(it.args.content ?? "").split("\n").slice(0, 80).map((l, i) => <div key={i} className="a">+ {l}</div>)}</div>;
    else if (it.name === "run_command") body = <pre>{`$ ${it.args.command}\n${it.result ?? "…"}`}</pre>;
    else body = <pre>{it.result ?? (isN8n ? JSON.stringify(it.args, null, 1).slice(0, 3000) : "…")}</pre>;
  }
  return (
    <div className="tool">
      <div className="tool-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown /> : <ChevronRight />}
        <Icon />
        <span className="what">{isN8n ? `n8n · ${N8nLabel(it.name)}` : meta?.label ?? it.name}</span>
        <span
          className={`arg ${filePath ? "link" : ""}`}
          title={arg}
          onClick={filePath ? (e) => { e.stopPropagation(); void useStore.getState().openFile(filePath.replace(/\\/g, "/")); } : undefined}
        >{arg}</span>
        <span className="st">{st}</span>
      </div>
      {body && <div className="tool-body">{body}</div>}
    </div>
  );
}

function ApprovalCard({ it }: { it: Extract<Item, { kind: "approval" }> }) {
  const decide = useStore((s) => s.decide);
  return (
    <div className="approval">
      <h4><ShieldAlert />{it.title}</h4>
      <code>{it.detail}</code>
      {it.state === "pending" ? (
        <div className="btns">
          <button className="btn primary" onClick={() => decide(it.id, true)} autoFocus><Check />Autoriser</button>
          <button className="btn" onClick={() => decide(it.id, false)}><X />Refuser</button>
        </div>
      ) : <div className="hint" style={{ marginTop: 6 }}>{it.state === "allowed" ? "Autorisé" : "Refusé"}</div>}
    </div>
  );
}

function Message({ it }: { it: Item }) {
  switch (it.kind) {
    case "user":
      return (
        <div className="msg-user">
          {it.file && <div className="ctx"><FileText size={11} />{it.file.split("/").pop()}{it.sel ? " · sélection" : ""}</div>}
          <div>{it.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className={`msg-ai ${it.streaming ? "streaming" : ""}`}>
          {it.streaming && !it.text && it.thinking && <div className="think"><span>{it.thinking}</span></div>}
          {it.text && <Md text={it.text} streaming={it.streaming} />}
        </div>
      );
    case "tool": return <ToolCard it={it} />;
    case "approval": return <ApprovalCard it={it} />;
    case "error": return <div className="err"><AlertTriangle /><div>{it.text}</div></div>;
  }
}
// ───────────────────────── Sélecteur de modèle ─────────────────────────

function ModelPicker({ index }: { index: number }) {
  const app = useStore((s) => s.app);
  const models = useStore((s) => s.models);
  const paneModel = useStore((s) => s.panes[index].model);
  const [q, setQ] = useState("");
  const cur = paneModel ?? app?.settings.model;
  const configured = PROVIDER_ORDER.filter((p) => app?.providers[p].configured);
  if (!configured.length)
    return <button className="pill warn" onClick={() => useStore.setState({ settings: "providers" })}><KeyRound />Ajouter une clé</button>;
  return (
    <Dropdown up trigger={(_o, t) => (
      <button className="pill" onClick={t} title="Choisir le modèle de cette conversation">
        <Sparkles /><span>{cur ? `${cur.id}` : "Choisir un modèle"}</span><ChevronDown />
      </button>
    )}>
      {(close) => (
        <>
          <input className="filter" autoFocus placeholder="Filtrer les modèles…" value={q} onChange={(e) => setQ(e.target.value)} />
          {configured.map((p) => {
            const list = models[p]?.models ?? [];
            const f = list.filter((m) => m.id.toLowerCase().includes(q.toLowerCase())).slice(0, q ? 100 : 60);
            return (
              <div key={p}>
                <div className="grp">{app!.providers[p].label}{models[p] && !models[p].live ? " · liste de secours" : ""}</div>
                {f.map((m) => (
                  <button key={m.id} className={`it ${cur?.provider === p && cur.id === m.id ? "cur" : ""}`} onClick={() => { useStore.getState().setPaneModel(index, p as ProviderId, m.id); close(); setQ(""); }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{m.id}</span>
                  </button>
                ))}
                {!f.length && <div className="hint" style={{ padding: "2px 9px" }}>Aucun modèle</div>}
              </div>
            );
          })}
        </>
      )}
    </Dropdown>
  );
}

// ───────────────────────── Micro ─────────────────────────

function MicButton({ index }: { index: number }) {
  const voice = useStore((s) => s.panes[index].voice);
  const info = useStore((s) => s.app?.voice);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => onMicLevel((pane, level) => { if (pane === index) ref.current?.style.setProperty("--lvl", level.toFixed(2)); }), [index]);
  const off = !info?.installed;
  const title = voice === "rec" ? "Terminer la dictée (elle s'arrête aussi toute seule après un silence)"
    : voice === "busy" ? "Transcription en cours…"
    : off ? "Dictée non installée — lance « npm run voice:install »"
    : info?.state === "loading" ? "Parler à cette conversation (le moteur vocal finit de se charger)"
    : info?.state === "error" ? `Moteur vocal en erreur : ${info.error}`
    : "Parler à cette conversation";
  return (
    <button ref={ref} className={`mic ${voice} ${off || info?.state === "error" ? "off" : ""}`} onClick={() => void useStore.getState().toggleMic(index)} title={title} aria-label={`Dictée vocale — conversation ${index + 1}`}>
      {voice === "busy" ? <Loader2 className="spin" /> : <Mic />}
    </button>
  );
}

// ───────────────────────── Zone de saisie ─────────────────────────

function Composer({ index }: { index: number }) {
  const draft = useStore((s) => s.panes[index].draft);
  const running = useStore((s) => s.panes[index].running);
  const sendWhenIdle = useStore((s) => s.panes[index].sendWhenIdle);
  const app = useStore((s) => s.app);
  const paneModel = useStore((s) => s.panes[index].model);
  const code = useStore((s) => s.show.code);
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.active);
  const includeActive = useStore((s) => s.includeActive);
  const allFiles = useStore((s) => s.allFiles);
  const { sendChat, stop, setDraft, loadAllFiles } = useStore.getState();
  const ta = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; q: string } | null>(null);
  const [hl, setHl] = useState(0);
  const activeTab = code ? tabs.find((t) => t.id === active && t.kind === "file") : undefined;
  const hasModel = !!(paneModel ?? app?.settings.model);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    return allFiles.filter((f) => f.toLowerCase().includes(q)).sort((a, b) => a.length - b.length).slice(0, 8);
  }, [mention, allFiles]);

  const onChange = (v: string, caret: number) => {
    setDraft(index, v);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
    if (m) { if (!allFiles.length) void loadAllFiles(); setMention({ start: caret - m[1].length - 1, q: m[1] }); setHl(0); }
    else setMention(null);
  };
  const pick = (f: string) => {
    if (!mention) return;
    const caret = ta.current!.selectionStart;
    setDraft(index, `${draft.slice(0, mention.start)}@${f} ${draft.slice(caret)}`);
    setMention(null);
    setTimeout(() => { const p = mention.start + f.length + 2; ta.current?.setSelectionRange(p, p); ta.current?.focus(); }, 0);
  };
  const submit = () => { if (draft.trim() && hasModel && !running) { setMention(null); sendChat(index, draft.trim()); } };

  return (
    <div className="composer">
      {mention && matches.length > 0 && (
        <div className="menu up" style={{ left: 0, right: 0, maxWidth: "none" }}>
          {matches.map((f, i) => (
            <button key={f} className={`it ${i === hl ? "hl" : ""}`} onMouseEnter={() => setHl(i)} onMouseDown={(e) => { e.preventDefault(); pick(f); }}>
              <FileIcon name={f} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", direction: "rtl" }}>{f}</span>
            </button>
          ))}
        </div>
      )}
      {sendWhenIdle && <div className="queued"><Hourglass />Partira dès que l'agent aura fini</div>}
      <textarea
        id={`composer-${index}`}
        ref={ta}
        rows={1}
        value={draft}
        placeholder={hasModel ? "Écris, ou dicte avec le micro" : "Choisis un modèle pour commencer"}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (mention && matches.length) {
            if (e.key === "ArrowDown") { e.preventDefault(); return setHl((hl + 1) % matches.length); }
            if (e.key === "ArrowUp") { e.preventDefault(); return setHl((hl - 1 + matches.length) % matches.length); }
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); return pick(matches[hl]); }
            if (e.key === "Escape") return setMention(null);
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
        }}
      />
      <div className="composer-bar">
        {activeTab && (
          <button className={`pill ${includeActive ? "on" : ""}`} onClick={() => useStore.setState({ includeActive: !includeActive })} title={includeActive ? "Le fichier ouvert est joint (cliquer pour retirer)" : "Joindre le fichier ouvert"}>
            <FileIcon name={activeTab.title} /><span>{activeTab.title}</span>{includeActive ? <Check /> : null}
          </button>
        )}
        <ModelPicker index={index} />
        <div className="composer-actions">
          <MicButton index={index} />
          {running
            ? <button className="send stop" onClick={() => stop(index)} title="Arrêter"><Square fill="currentColor" /></button>
            : <button className="send" disabled={!draft.trim() || !hasModel} onClick={submit} title="Envoyer (Entrée)"><ArrowUp /></button>}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Fenêtre de conversation ─────────────────────────

const SUGGESTIONS = [
  { icon: BookOpen, text: "Explique-moi l'architecture de ce projet" },
  { icon: Bug, text: "Cherche les bugs probables dans ce projet et corrige les plus sûrs" },
  { icon: FlaskConical, text: "Lance les tests et corrige ce qui échoue" },
];

export function ChatPane({ index }: { index: number }) {
  const pane = useStore((s) => s.panes[index]);
  const chats = useStore((s) => s.chats);
  const app = useStore((s) => s.app);
  const { items, running, title } = pane;
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anyKey = !!app && Object.values(app.providers).some((p) => p.configured);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <section className="pane" onFocusCapture={() => useStore.getState().focused !== index && useStore.setState({ focused: index })} aria-label={`Conversation ${index + 1}`}>
      <div className="agent-head">
        <span className={`num ${running ? "busy" : ""}`} title={running ? "L'agent travaille" : `Conversation ${index + 1}`}>{index + 1}</span>
        <span className="ttl" title={title}>{title}</span>
        <button className="icon-btn" title="Nouvelle conversation" onClick={() => useStore.getState().newChat(index)}><Plus /></button>
        <Dropdown align="right" trigger={(_o, t) => <button className="icon-btn" title="Historique" onClick={() => { void useStore.getState().refreshChats(); t(); }}><History /></button>}>
          {(close) => (
            <>
              <div className="grp">Conversations récentes</div>
              {chats.length === 0 && <div className="hint" style={{ padding: "2px 9px 6px" }}>Aucune pour l'instant.</div>}
              {chats.slice(0, 30).map((c) => (
                <div key={c.id} className="it" style={{ cursor: "pointer" }} onClick={() => { close(); void useStore.getState().loadChat(index, c.id); }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{c.title}</span>
                  <button className="icon-btn sm" title="Supprimer" onClick={async (e) => { e.stopPropagation(); await fetch(`/api/chats/${c.id}`, { method: "DELETE" }); void useStore.getState().refreshChats(); }}><Trash2 /></button>
                </div>
              ))}
            </>
          )}
        </Dropdown>
      </div>
      <div className="chat" ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {items.length === 0 ? (
          <div className="hello">
            <h2>Que fait-on ?</h2>
            <p>L'agent lit, modifie, exécute — directement dans ce dossier.</p>
            {!anyKey && (
              <div className="connect">Pour démarrer, connecte une clé Claude, Z.ai, Mistral ou OpenRouter.
                <br /><button className="btn primary" onClick={() => useStore.setState({ settings: "providers" })}><KeyRound />Connecter une clé</button></div>
            )}
            <div className="chips">
              {SUGGESTIONS.map((s) => <button key={s.text} className="chip" onClick={() => { useStore.getState().setDraft(index, s.text); document.getElementById(`composer-${index}`)?.focus(); }}><s.icon />{s.text}</button>)}
              {app?.n8n.configured && <button className="chip" onClick={() => { useStore.getState().setDraft(index, "Crée un workflow n8n qui "); document.getElementById(`composer-${index}`)?.focus(); }}><Workflow />Crée un workflow n8n qui…</button>}
            </div>
          </div>
        ) : items.map((it, i) => <Message key={i} it={it} />)}
        {running && items[items.length - 1]?.kind !== "assistant" && items[items.length - 1]?.kind !== "approval" && (
          <div className="hint" style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}><Loader2 size={13} className="spin" />Réflexion…</div>
        )}
      </div>
      <Composer index={index} />
    </section>
  );
}
