import { Circle, Workflow, Zap, ShieldCheck } from "lucide-react";
import { useStore } from "../store";

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

export function StatusBar() {
  const { app, online, running, usage, active, tabs, workflows } = useStore();
  const tab = tabs.find((t) => t.id === active);
  const model = app?.settings.model;
  return (
    <div className="status">
      <span className={online ? "good" : "bad"} style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><Circle size={8} fill="currentColor" />{online ? (running ? "L'agent travaille…" : "Prêt") : "Hors ligne"}</span>
      {tab && <span>{tab.kind === "n8n" ? "workflow n8n" : tab.path}</span>}
      <span className="sp" />
      {usage.input + usage.output > 0 && <span title="Jetons de cette conversation">↑ {k(usage.input)} · ↓ {k(usage.output)}</span>}
      {model && <span>{model.id}</span>}
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
