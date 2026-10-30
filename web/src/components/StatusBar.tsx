import { Circle, Workflow, Zap, ShieldCheck } from "lucide-react";
import { useStore } from "../store";

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

export function StatusBar() {
  const { app, online, panes, show, active, tabs, workflows } = useStore();
  const tab = show.code ? tabs.find((t) => t.id === active) : undefined;
  const busy = panes.filter((p) => p.running).length;
  const input = panes.reduce((n, p) => n + p.usage.input, 0);
  const output = panes.reduce((n, p) => n + p.usage.output, 0);
  const voice = app?.voice;
  return (
    <div className="status">
      <span className={online ? "good" : "bad"} style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
        <Circle size={8} fill="currentColor" />{online ? (busy ? `${busy} agent${busy > 1 ? "s" : ""} au travail…` : "Prêt") : "Hors ligne"}
      </span>
      {tab && <span>{tab.kind === "n8n" ? "workflow n8n" : tab.path}</span>}
      <span className="sp" />
      {voice?.installed && (
        <span className={voice.state === "ready" ? "good" : voice.state === "error" ? "bad" : ""} title={voice.error || `Dictée locale (Whisper ${voice.model}${voice.device ? `, ${voice.device}` : ""})`}>
          Voix : {voice.state === "ready" ? "prête" : voice.state === "error" ? "erreur" : voice.state === "loading" ? "chargement…" : "en veille"}
        </span>
      )}
      {input + output > 0 && <span title="Jetons des quatre conversations">↑ {k(input)} · ↓ {k(output)}</span>}
      <button onClick={() => void useStore.getState().patchSettings({ approval: app?.settings.approval === "ask" ? "auto" : "ask" })} title="Basculer autonome / prudent">
        {app?.settings.approval === "ask" ? <><ShieldCheck />Prudent</> : <><Zap />Autonome</>}
      </button>
      <button onClick={() => useStore.setState({ settings: "n8n" })} title="Connexion n8n">
        <Workflow />{app?.n8n.configured ? <span className="good">n8n · {workflows.length}</span> : "n8n non connecté"}
      </button>
      <span>v{app?.version}</span>
    </div>
  );
}
