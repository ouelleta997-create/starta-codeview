import { Code2, FolderOpen, Mic, Search, Settings, SquareTerminal, ChevronDown, Clock } from "lucide-react";
import { useStore } from "../store";
import { Dropdown, Logo } from "./ui";

export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function TitleBar() {
  const { app, show, toggle, pickFolder, openFolder } = useStore();
  const ws = app?.settings.workspace;
  const autoSend = !!app?.settings.voiceAutoSend;
  return (
    <div className="titlebar">
      <div className="brand"><Logo /> <span>CodeView</span></div>
      <Dropdown trigger={(_o, t) => (
        <button className="ws-btn" onClick={t} title={ws ?? "Aucun dossier"}>
          <FolderOpen size={14} /><span>{ws ? baseName(ws) : "Ouvrir un dossier"}</span><ChevronDown size={12} />
        </button>
      )}>
        {(close) => (
          <>
            <button className="it" onClick={() => { close(); void pickFolder(); }}><FolderOpen size={14} />Ouvrir un dossier…</button>
            {(app?.settings.recents.length ?? 0) > 0 && <div className="grp">Récents</div>}
            {app?.settings.recents.map((r) => (
              <button key={r} className={`it ${r === ws ? "cur" : ""}`} onClick={() => { close(); void openFolder(r); }} title={r}>
                <Clock size={13} /><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{baseName(r)}</span><small>{r.length > 28 ? `…${r.slice(-26)}` : r}</small>
              </button>
            ))}
          </>
        )}
      </Dropdown>
      {show.code ? (
        <button className="search-pill" onClick={() => { void useStore.getState().loadAllFiles(); useStore.setState({ palette: "files" }); }}>
          <Search size={13} /> Rechercher un fichier <kbd>Ctrl P</kbd>
        </button>
      ) : <span className="sp" />}
      <button
        className={`pill auto-send ${autoSend ? "on" : ""}`}
        onClick={() => void useStore.getState().patchSettings({ voiceAutoSend: !autoSend })}
        title={autoSend ? "Envoi automatique : ce que tu dictes part tout de suite à l'agent (cliquer pour désactiver)" : "Envoi manuel : la dictée remplit la zone de saisie, tu envoies toi-même (cliquer pour envoyer automatiquement)"}
      >
        <Mic /><span>{autoSend ? "Envoi auto" : "Envoi manuel"}</span>
      </button>
      <button className={`icon-btn ${show.code ? "on" : ""}`} onClick={() => toggle("code")} title="Éditeur de code (Ctrl+B)"><Code2 /></button>
      <button className={`icon-btn ${show.term ? "on" : ""}`} onClick={() => toggle("term")} title="Terminal (Ctrl+J)"><SquareTerminal /></button>
      <button className="icon-btn" onClick={() => useStore.setState({ settings: "providers" })} title="Réglages (Ctrl+,)">
        <Settings />
        {app && !Object.values(app.providers).some((p) => p.configured) && <span className="dot-badge" />}
      </button>
    </div>
  );
}
