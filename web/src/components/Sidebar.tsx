import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FilePlus, FolderPlus, RefreshCw, Search, Workflow as WfIcon, Files, Plus, Trash2, Power } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import { FileIcon } from "./ui";

function useTreeActions() {
  const { loadDir, openFile, say } = useStore();
  const refreshDir = (p: string) => loadDir(p.split("/").slice(0, -1).join("/"));
  return {
    async create(parent: string, name: string, dir: boolean) {
      const p = parent ? `${parent}/${name}` : name;
      try { await api("POST", "/api/fs/create", { path: p, dir }); await loadDir(parent); if (!dir) await openFile(p); } catch (e) { say((e as Error).message); }
    },
    async rename(from: string, to: string) {
      try { await api("POST", "/api/fs/rename", { from, to }); await refreshDir(from); await refreshDir(to); } catch (e) { say((e as Error).message); }
    },
    async remove(p: string) {
      if (!confirm(`Supprimer définitivement « ${p} » ?`)) return;
      try {
        await api("POST", "/api/fs/delete", { path: p });
        for (const t of useStore.getState().tabs) if (t.kind === "file" && (t.path === p || t.path.startsWith(`${p}/`))) useStore.setState((s) => ({ tabs: s.tabs.map((x) => (x.id === t.id ? { ...x, dirty: false } : x)) })), useStore.getState().closeTab(t.id);
        await refreshDir(p);
      } catch (e) { say((e as Error).message); }
    },
  };
}

type Editing = { kind: "new-file" | "new-dir" | "rename"; path: string } | null;

function Node({ path, name, dir, ignored, depth, editing, setEditing, actions }: { path: string; name: string; dir: boolean; ignored: boolean; depth: number; editing: Editing; setEditing: (e: Editing) => void; actions: ReturnType<typeof useTreeActions> }) {
  const { expanded, toggleDir, openFile, active } = useStore();
  const open = !!expanded[path];
  const sel = active === `file:${path}`;
  const renaming = editing?.kind === "rename" && editing.path === path;
  return (
    <>
      <div
        className={`row ${sel ? "sel" : ""} ${ignored ? "ignored" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (dir ? toggleDir(path) : openFile(path))}
        onContextMenu={(e) => { e.preventDefault(); setEditing({ kind: "rename", path }); }}
        title={path}
      >
        {dir ? <ChevronRight className={`chev ${open ? "open" : ""}`} /> : <span style={{ width: 12 }} />}
        <FileIcon name={name} dir={dir} open={open} />
        {renaming ? (
          <input
            autoFocus defaultValue={name} onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.target.setSelectionRange(0, name.includes(".") ? name.lastIndexOf(".") : name.length)}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(null);
              if (e.key === "Enter") { const v = e.currentTarget.value.trim(); setEditing(null); if (v && v !== name) void actions.rename(path, `${path.split("/").slice(0, -1).concat(v).join("/")}`); }
            }}
          />
        ) : (
          <>
            <span className="name">{name}</span>
            <span className="ext" onClick={(e) => { e.stopPropagation(); void actions.remove(path); }} title="Supprimer"><Trash2 size={12} /></span>
          </>
        )}
      </div>
      {dir && open && <Children path={path} depth={depth + 1} editing={editing} setEditing={setEditing} actions={actions} />}
      {dir && open && editing && editing.kind !== "rename" && editing.path === path && <NewRow depth={depth + 1} kind={editing.kind} parent={path} setEditing={setEditing} actions={actions} />}
    </>
  );
}

function NewRow({ depth, kind, parent, setEditing, actions }: { depth: number; kind: "new-file" | "new-dir"; parent: string; setEditing: (e: Editing) => void; actions: ReturnType<typeof useTreeActions> }) {
  return (
    <div className="row" style={{ paddingLeft: 8 + depth * 12 + 18 }}>
      <FileIcon name={kind === "new-dir" ? "" : "x.txt"} dir={kind === "new-dir"} />
      <input
        autoFocus placeholder={kind === "new-dir" ? "nom-du-dossier" : "nom-du-fichier.ext"}
        onBlur={() => setEditing(null)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(null);
          if (e.key === "Enter") { const v = e.currentTarget.value.trim(); setEditing(null); if (v) void actions.create(parent, v, kind === "new-dir"); }
        }}
      />
    </div>
  );
}

function Children({ path, depth, editing, setEditing, actions }: { path: string; depth: number; editing: Editing; setEditing: (e: Editing) => void; actions: ReturnType<typeof useTreeActions> }) {
  const entries = useStore((s) => s.dirs[path]);
  if (!entries) return null;
  return <>{entries.map((e) => <Node key={e.path} path={e.path} name={e.name} dir={e.dir} ignored={e.ignored} depth={depth} editing={editing} setEditing={setEditing} actions={actions} />)}</>;
}

function Files_() {
  const { dirs, loadDir, app } = useStore();
  const [editing, setEditing] = useState<Editing>(null);
  const actions = useTreeActions();
  const rootName = app?.settings.workspace?.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const active = useStore((s) => s.tabs.find((t) => t.id === s.active));
  const parentOfActive = active?.kind === "file" ? active.path.split("/").slice(0, -1).join("/") : "";
  useEffect(() => { if (!dirs[""]) void loadDir(""); }, [dirs, loadDir]);
  const startNew = (kind: "new-file" | "new-dir") => {
    if (parentOfActive && !useStore.getState().expanded[parentOfActive]) void useStore.getState().toggleDir(parentOfActive);
    setEditing({ kind, path: parentOfActive });
  };
  return (
    <>
      <div className="panel-head"><span>{rootName}</span><span className="sp" />
        <button className="icon-btn sm" title="Nouveau fichier" onClick={() => startNew("new-file")}><FilePlus /></button>
        <button className="icon-btn sm" title="Nouveau dossier" onClick={() => startNew("new-dir")}><FolderPlus /></button>
        <button className="icon-btn sm" title="Rafraîchir" onClick={() => { for (const d of Object.keys(useStore.getState().dirs)) void loadDir(d); }}><RefreshCw /></button>
      </div>
      <div className="scroll tree">
        <Children path="" depth={0} editing={editing} setEditing={setEditing} actions={actions} />
        {editing && editing.kind !== "rename" && editing.path === "" && <NewRow depth={0} kind={editing.kind} parent="" setEditing={setEditing} actions={actions} />}
        {dirs[""]?.length === 0 && <div className="empty">Dossier vide.</div>}
      </div>
    </>
  );
}

function N8nPanel() {
  const { app, workflows, n8nError, refreshWorkflows, openN8n, active, say } = useStore();
  const [q, setQ] = useState("");
  const loaded = useRef(false);
  useEffect(() => { if (!loaded.current) { loaded.current = true; void refreshWorkflows(); } }, [refreshWorkflows]);
  const shown = useMemo(() => workflows.filter((w) => w.name.toLowerCase().includes(q.toLowerCase())), [workflows, q]);

  if (!app?.n8n.configured)
    return (
      <div className="empty">
        <strong>n8n n'est pas connecté.</strong><br />Ajoute l'URL de ton instance et une clé API pour lister, éditer et créer des workflows — à la main ou en parlant à l'agent.
        <br /><button className="btn primary" style={{ marginTop: 10 }} onClick={() => useStore.setState({ settings: "n8n" })}>Connecter n8n</button>
      </div>
    );

  const toggle = async (id: string, on: boolean) => {
    if (on && !confirm("Activer ce workflow ? Il se déclenchera pour de vrai.")) return;
    try { await api("POST", `/api/n8n/workflows/${id}/${on ? "activate" : "deactivate"}`); await refreshWorkflows(); } catch (e) { say((e as Error).message); }
  };
  const ask = () => { const i = useStore.getState().focused; useStore.getState().setDraft(i, "Crée un workflow n8n qui "); setTimeout(() => document.getElementById(`composer-${i}`)?.focus(), 30); };

  return (
    <>
      <div className="panel-head"><span>Workflows</span><span className="sp" />
        <button className="icon-btn sm" title="Demander un nouveau workflow à l'agent" onClick={ask}><Plus /></button>
        <button className="icon-btn sm" title="Rafraîchir" onClick={() => void refreshWorkflows()}><RefreshCw /></button>
      </div>
      <label className="search"><Search /><input placeholder="Filtrer…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <div className="scroll">
        {n8nError && <div className="empty" style={{ color: "var(--danger)" }}>{n8nError}</div>}
        {shown.map((w) => (
          <div key={w.id} className={`wf ${active === `n8n:${w.id}` ? "row sel" : ""}`} onClick={() => void openN8n(w.id)}>
            <span className={`led ${w.active ? "on" : ""}`} />
            <div className="nm">{w.name}<small>{w.nodes != null ? `${w.nodes} nœuds · ` : ""}{w.active ? "actif" : "inactif"}</small></div>
            <button className="icon-btn sm" title={w.active ? "Désactiver" : "Activer"} onClick={(e) => { e.stopPropagation(); void toggle(w.id, !w.active); }}><Power /></button>
          </div>
        ))}
        {!n8nError && !shown.length && <div className="empty">{workflows.length ? "Aucun résultat." : <>Aucun workflow. <a style={{ color: "var(--accent)", cursor: "pointer" }} onClick={ask}>Demander à l'agent d'en créer un.</a></>}</div>}
      </div>
    </>
  );
}

export function Sidebar() {
  const { sidebarTab } = useStore();
  const set = (t: "files" | "n8n") => useStore.setState({ sidebarTab: t });
  return (
    <>
      <div className="seg">
        <button className={sidebarTab === "files" ? "on" : ""} onClick={() => set("files")}><Files size={14} />Fichiers</button>
        <button className={sidebarTab === "n8n" ? "on" : ""} onClick={() => set("n8n")}><WfIcon size={14} />n8n</button>
      </div>
      {sidebarTab === "files" ? <Files_ /> : <N8nPanel />}
    </>
  );
}
