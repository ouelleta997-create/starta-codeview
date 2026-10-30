import { useEffect, useState } from "react";
import { PANES, useStore } from "../store";
import { Resizer, usePersisted } from "./ui";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { EditorArea } from "./EditorArea";
import { TerminalPanel } from "./Terminal";
import { ChatPane } from "./Agent";
import { StatusBar } from "./StatusBar";
import { Settings } from "./Settings";
import { Palette } from "./Palette";
import { Welcome } from "./Welcome";
import { monaco, themeName } from "../monaco";

export function App() {
  const { app, init, show, settings, palette, toast } = useStore();
  const [sbW, setSbW] = usePersisted("cv.sidebar", 264);
  const [edW, setEdW] = usePersisted("cv.editor", 620);
  const [tmH, setTmH] = usePersisted("cv.term", 260);
  const [err, setErr] = useState("");

  useEffect(() => {
    init().then(() => {
      const m = /^#settings\/(providers|n8n|agent|voice|appearance)$/.exec(location.hash);
      if (m) { useStore.setState({ settings: m[1] as "n8n" }); history.replaceState(null, "", location.pathname); }
    }).catch((e) => setErr(e.message));
  }, [init]);

  // Thème : clair / sombre / système.
  const pref = app?.settings.theme ?? "dark";
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const t = pref === "system" ? (mq.matches ? "dark" : "light") : pref;
      document.documentElement.dataset.theme = t;
      monaco.editor.setTheme(themeName(t));
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);

  // Raccourcis globaux.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (e.key === "Escape" && s.settings) return void useStore.setState({ settings: false });
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "p" && !e.shiftKey) { e.preventDefault(); void s.loadAllFiles(); useStore.setState({ palette: "files" }); }
      else if (k === "p" && e.shiftKey) { e.preventDefault(); useStore.setState({ palette: "cmd" }); }
      else if (k === "s") { e.preventDefault(); void s.saveTab(); }
      else if (k === "b") { e.preventDefault(); s.toggle("code"); }
      else if (k === "`" || k === "j") { e.preventDefault(); s.toggle("term"); }
      else if (k === "l") { e.preventDefault(); document.getElementById(`composer-${s.focused}`)?.focus(); }
      else if (k >= "1" && k <= String(PANES)) { e.preventDefault(); document.getElementById(`composer-${Number(k) - 1}`)?.focus(); }
      else if (k === "," ) { e.preventDefault(); useStore.setState({ settings: "providers" }); }
      else if (k === "w" && s.active && s.show.code) { e.preventDefault(); s.closeTab(s.active); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (err) return <div className="welcome"><div className="box"><h1>Serveur injoignable</h1><p>{err}</p></div></div>;
  if (!app) return null;
  const hasWs = !!app.settings.workspace;

  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        {hasWs ? (
          <>
            {show.code && (
              <>
                <div className="col sidebar" style={{ width: sbW }}><Sidebar /></div>
                <Resizer onDrag={(d) => setSbW(Math.min(560, Math.max(180, sbW + d)))} />
                <div className="col editor-col" style={{ width: edW }}>
                  <EditorArea />
                  {show.term && (
                    <>
                      <Resizer horizontal onDrag={(d) => setTmH(Math.min(700, Math.max(100, tmH - d)))} />
                      <div className="term" style={{ height: tmH }}><TerminalPanel /></div>
                    </>
                  )}
                </div>
                <Resizer onDrag={(d) => setEdW(Math.min(1400, Math.max(300, edW + d)))} />
              </>
            )}
            <div className="panes">
              {Array.from({ length: PANES }, (_, i) => <ChatPane key={i} index={i} />)}
            </div>
          </>
        ) : <div className="col grow editor-col"><Welcome /></div>}
      </div>
      <StatusBar />
      {settings && <Settings />}
      {palette && <Palette />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
