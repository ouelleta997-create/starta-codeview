import { useEffect, useRef } from "react";
import { X, ChevronRight, Save, Code2 } from "lucide-react";
import { useStore } from "../store";
import { FileIcon } from "./ui";
import { monaco, getModel, getViewState, saveViewState, setCurrentEditor, themeName, isExternalUpdate } from "../monaco";

function Tabs() {
  const { tabs, active, activate, closeTab } = useStore();
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <div key={t.id} className={`tab ${t.id === active ? "on" : ""} ${t.kind} ${t.dirty ? "is-dirty" : ""}`} onClick={() => activate(t.id)} onAuxClick={(e) => e.button === 1 && closeTab(t.id)} title={t.path}>
          {t.kind === "file" && <FileIcon name={t.title} />}
          <span className="t">{t.title}</span>
          <button className="x" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} title="Fermer">
            {t.dirty ? <span className="dirty" /> : null}
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}

function MonacoHost() {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const { active, tabs } = useStore();
  const tab = tabs.find((t) => t.id === active);
  const ready = !!tab && !tab.loading && !tab.note;

  useEffect(() => {
    const e = monaco.editor.create(host.current!, {
      model: null,
      theme: themeName((document.documentElement.dataset.theme as "dark" | "light") ?? "dark"),
      fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 21,
      fontLigatures: true,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: "on",
      cursorBlinking: "smooth",
      padding: { top: 10, bottom: 10 },
      renderLineHighlight: "line",
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: false },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      wordWrap: "off",
      tabSize: 2,
      detectIndentation: true,
    });
    editor.current = e;
    setCurrentEditor(e);
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void useStore.getState().saveTab());
    return () => { setCurrentEditor(null); e.dispose(); };
  }, []);

  // Changement d'onglet : bascule du modèle, vue (curseur, défilement) préservée.
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const e = editor.current;
    if (!e) return;
    if (prev.current) saveViewState(prev.current, e.saveViewState());
    prev.current = ready ? active : null;
    if (!ready || !active) { e.setModel(null); return; }
    const m = getModel(active);
    if (!m) return;
    e.setModel(m);
    e.restoreViewState(getViewState(active));
    e.focus();
    const sub = m.onDidChangeContent(() => {
      if (isExternalUpdate()) return;
      const t = useStore.getState().tabs.find((x) => x.id === active);
      if (t && !t.dirty) useStore.getState().markDirty(active, true);
    });
    return () => sub.dispose();
  }, [active, ready]);

  return <div className="monaco-host" style={{ display: ready ? "block" : "none" }}><div ref={host} /></div>;
}

export function EditorArea() {
  const { tabs, active, saveTab } = useStore();
  const tab = tabs.find((t) => t.id === active);
  return (
    <>
      <Tabs />
      {tab && (
        <div className="crumbs">
          {tab.kind === "n8n" ? <span>n8n</span> : tab.path.split("/").map((p, i, a) => <span key={i} style={{ display: "contents" }}>{i > 0 && <ChevronRight size={12} />}<span style={i === a.length - 1 ? { color: "var(--text2)" } : undefined}>{p}</span></span>)}
          {tab.kind === "n8n" && <><ChevronRight size={12} /><span style={{ color: "var(--text2)" }}>{tab.path}</span></>}
          <span className="sp" />
          {tab.dirty && <button className="save" onClick={() => void saveTab(tab.id)}><Save size={11} style={{ verticalAlign: -1, marginRight: 4 }} />{tab.kind === "n8n" ? "Envoyer à n8n" : "Enregistrer"}</button>}
        </div>
      )}
      <MonacoHost />
      {!tab && (
        <div className="editor-empty">
          <div className="box">
            <Code2 />
            <div>Ouvre un fichier dans l'arborescence</div>
            <div><kbd>Ctrl</kbd> <kbd>P</kbd> chercher · <kbd>Ctrl</kbd> <kbd>1</kbd>…<kbd>4</kbd> aller à un chat · <kbd>Ctrl</kbd> <kbd>J</kbd> terminal</div>
          </div>
        </div>
      )}
      {tab?.loading && <div className="notice">Chargement…</div>}
      {tab?.note && <div className="notice">{tab.note}</div>}
    </>
  );
}
