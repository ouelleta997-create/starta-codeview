import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Resizer, usePersisted } from "./ui";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { EditorArea } from "./EditorArea";
import { TerminalPanel } from "./Terminal";
import { AgentPanel } from "./Agent";
import { StatusBar } from "./StatusBar";
import { Settings } from "./Settings";
import { Palette } from "./Palette";
import { Welcome } from "./Welcome";
import { monaco, themeName } from "../monaco";

export function App() {
  const { app, init, show, settings, palette, toast } = useStore();
  const [sbW, setSbW] = usePersisted("cv.sidebar", 264);
  const [agW, setAgW] = usePersisted("cv.agent", 420);
  const [tmH, setTmH] = usePersisted("cv.term", 260);
  const [err, setErr] = useState("");

  useEffect(() => { init().catch((e) => setErr(e.message)); }, [init]);

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
      else if (k === "b") { e.preventDefault(); s.toggle("sidebar"); }
      else if (k === "`" || k === "j") { e.preventDefault(); s.toggle("term"); }
      else if (k === "l") { e.preventDefault(); useStore.setState((x) => ({ show: { ...x.show, agent: true } })); setTimeout(() => document.getElementById("composer")?.focus(), 30); }
      else if (k === "," ) { e.preventDefault(); useStore.setState({ settings: "providers" }); }
      else if (k === "w" && s.active) { e.preventDefault(); s.closeTab(s.active); }
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
        {show.sidebar && hasWs && (
          <>
            <div className="col sidebar" style={{ width: sbW }}><Sidebar /></div>
            <Resizer onDrag={(d) => setSbW(Math.min(560, Math.max(180, sbW + d)))} />
          </>
        )}
        <div className="col grow editor-col">
          {hasWs ? (
            <>
              <EditorArea />
              {show.term && (
                <>
                  <Resizer horizontal onDrag={(d) => setTmH(Math.min(700, Math.max(100, tmH - d)))} />
                  <div className="term" style={{ height: tmH }}><TerminalPanel /></div>
                </>
              )}
            </>
          ) : <Welcome />}
        </div>
        {show.agent && (
          <>
            <Resizer onDrag={(d) => setAgW(Math.min(760, Math.max(320, agW - d)))} />
            <div className="col agent" style={{ width: agW }}><AgentPanel /></div>
          </>
        )}
      </div>
      <StatusBar />
      {settings && <Settings />}
      {palette && <Palette />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
