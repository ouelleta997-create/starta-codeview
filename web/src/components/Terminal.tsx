import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Eraser, X, Square } from "lucide-react";
import { useStore } from "../store";
import { wsSend } from "../api";
import { attachTerminal, clearTerminalBuffer, onCommandExit, terminalIsEmpty, writePrompt } from "../terminal-bus";

const THEMES = {
  dark: { background: "#181818", foreground: "#d4d4d4", cursor: "#2fbf8f", selectionBackground: "#2fbf8f40", black: "#2a2a2a", red: "#f0645a", green: "#2fbf8f", yellow: "#e5b567", blue: "#6aa9ff", magenta: "#c792ea", cyan: "#7fdbca", white: "#d4d4d4" },
  light: { background: "#ffffff", foreground: "#1c1c1c", cursor: "#12936b", selectionBackground: "#12936b30", black: "#1c1c1c", red: "#d0463c", green: "#12936b", yellow: "#a87a1f", blue: "#2a6fd6", magenta: "#8b4fc7", cyan: "#14808a", white: "#5c5c5c" },
};
const themeNow = () => THEMES[(document.documentElement.dataset.theme as "dark" | "light") ?? "dark"];

export function TerminalPanel() {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const { termCwd, app } = useStore();

  useEffect(() => {
    const t = new Terminal({
      fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
      fontSize: 12.5, lineHeight: 1.35, cursorBlink: true, scrollback: 8000, theme: themeNow(),
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current!);
    term.current = t;

    const fresh = terminalIsEmpty();
    attachTerminal((d) => t.write(d));
    if (fresh) writePrompt();
    t.focus();

    let line = "";
    let running = false;
    const history: string[] = [];
    let hIdx = 0;
    const offExit = onCommandExit(() => { running = false; });

    t.onData((d) => {
      if (running) { if (d === "\x03") wsSend({ type: "term_kill" }); return; }
      if (d === "\r") {
        const cmd = line.trim();
        t.write("\r\n");
        line = "";
        if (!cmd) return writePrompt();
        history.push(cmd);
        hIdx = history.length;
        if (/^(clear|cls)$/i.test(cmd)) { t.clear(); clearTerminalBuffer(); return writePrompt(); }
        running = true;
        if (!wsSend({ type: "term", command: cmd })) { running = false; t.write("Connexion perdue.\r\n"); writePrompt(); }
      } else if (d === "\x7f") { if (line) { line = line.slice(0, -1); t.write("\b \b"); } }
      else if (d === "\x1b[A") { if (hIdx > 0) { t.write("\b \b".repeat(line.length)); line = history[--hIdx]; t.write(line); } }
      else if (d === "\x1b[B") { t.write("\b \b".repeat(line.length)); hIdx = Math.min(hIdx + 1, history.length); line = history[hIdx] ?? ""; t.write(line); }
      else if (d === "\x03") { t.write("^C"); line = ""; writePrompt(); }
      else if (d >= " " && !d.startsWith("\x1b")) { line += d; t.write(d); }
    });

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* panneau masqué */ } });
    ro.observe(host.current!);
    const themeObs = new MutationObserver(() => { t.options.theme = themeNow(); });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { offExit(); attachTerminal(null); ro.disconnect(); themeObs.disconnect(); t.dispose(); };
  }, []);

  return (
    <>
      <div className="term-head">
        <span>Terminal</span><span className="cwd">{termCwd}</span><span className="sp" />
        <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>{app?.shell}</span>
        <button className="icon-btn sm" title="Interrompre (Ctrl+C)" onClick={() => wsSend({ type: "term_kill" })}><Square /></button>
        <button className="icon-btn sm" title="Effacer" onClick={() => { term.current?.clear(); clearTerminalBuffer(); }}><Eraser /></button>
        <button className="icon-btn sm" title="Fermer" onClick={() => useStore.getState().toggle("term")}><X /></button>
      </div>
      <div className="xterm-host" ref={host} />
    </>
  );
}
