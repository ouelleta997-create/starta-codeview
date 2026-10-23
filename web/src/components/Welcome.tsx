import { FolderOpen, KeyRound } from "lucide-react";
import { useStore } from "../store";
import { Logo } from "./ui";
import { baseName } from "./TitleBar";

export function Welcome() {
  const { app, pickFolder, openFolder } = useStore();
  const anyKey = !!app && Object.values(app.providers).some((p) => p.configured);
  return (
    <div className="welcome">
      <div className="box">
        <Logo className="logo" />
        <h1>Starta CodeView</h1>
        <p>Un éditeur de code local, des agents qui travaillent pour toi.</p>
        <div className="actions">
          <button className="btn primary" onClick={() => void pickFolder()}><FolderOpen />Ouvrir un dossier</button>
          {!anyKey && <button className="btn" onClick={() => useStore.setState({ settings: "providers" })}><KeyRound />Connecter une clé</button>}
        </div>
        {(app?.settings.recents.length ?? 0) > 0 && (
          <>
            <h4>Récents</h4>
            {app!.settings.recents.map((r) => (
              <button key={r} className="recent" onClick={() => void openFolder(r)}>{baseName(r)}<small>{r}</small></button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
