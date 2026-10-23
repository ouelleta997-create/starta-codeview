import { useEffect, useMemo, useRef, useState } from "react";
import { Search, FolderOpen, Settings, SquareTerminal, PanelLeft, PanelRight, MessageSquarePlus, Sun, Moon, RefreshCw, Workflow, Command } from "lucide-react";
import { useStore } from "../store";
import { FileIcon } from "./ui";

interface Cmd { id: string; label: string; icon: typeof Search; run: () => void; hint?: string }

function score(q: string, s: string): number {
  // Recherche floue : tous les caractères dans l'ordre ; bonus début de mot / nom de fichier.
  const t = s.toLowerCase();
  let i = 0, sc = 0, last = -2;
  const base = t.lastIndexOf("/") + 1;
  for (const c of q) {
    const j = t.indexOf(c, i);
    if (j < 0) return -1;
    sc += j === last + 1 ? 3 : 1;
    if (j === 0 || "/._- ".includes(t[j - 1])) sc += 2;
    if (j >= base) sc += 1;
    last = j;
    i = j + 1;
  }
  return sc - t.length * 0.02;
}

export function Palette() {
  const { palette, allFiles, app, openFile } = useStore();
  const [q, setQ] = useState(palette === "cmd" ? ">" : "");
  const [hl, setHl] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ palette: null });
  const s = useStore.getState();
  const dark = (document.documentElement.dataset.theme ?? "dark") === "dark";

  const cmds: Cmd[] = useMemo(() => [
    { id: "folder", label: "Ouvrir un dossier…", icon: FolderOpen, run: () => void s.pickFolder() },
    { id: "settings", label: "Réglages : fournisseurs et clés", icon: Settings, run: () => useStore.setState({ settings: "providers" }), hint: "Ctrl ," },
    { id: "n8n", label: "Réglages : connexion n8n", icon: Workflow, run: () => useStore.setState({ settings: "n8n" }) },
    { id: "chat", label: "Nouvelle conversation avec l'agent", icon: MessageSquarePlus, run: () => { s.newChat(); useStore.setState((x) => ({ show: { ...x.show, agent: true } })); setTimeout(() => document.getElementById("composer")?.focus(), 30); }, hint: "Ctrl L" },
    { id: "term", label: "Afficher / masquer le terminal", icon: SquareTerminal, run: () => s.toggle("term"), hint: "Ctrl J" },
    { id: "side", label: "Afficher / masquer la barre latérale", icon: PanelLeft, run: () => s.toggle("sidebar"), hint: "Ctrl B" },
    { id: "agent", label: "Afficher / masquer l'agent", icon: PanelRight, run: () => s.toggle("agent") },
    { id: "theme", label: dark ? "Passer au thème clair" : "Passer au thème sombre", icon: dark ? Sun : Moon, run: () => void s.patchSettings({ theme: dark ? "light" : "dark" }) },
    { id: "wf", label: "Rafraîchir les workflows n8n", icon: RefreshCw, run: () => { useStore.setState({ sidebarTab: "n8n" }); void s.refreshWorkflows(); } },
  ], [dark]); // eslint-disable-line react-hooks/exhaustive-deps

  const isCmd = q.startsWith(">");
  const term = (isCmd ? q.slice(1) : q).trim().toLowerCase();

  const rows = useMemo(() => {
    if (isCmd) return cmds.map((c) => ({ c, sc: term ? score(term, c.label) : 0 })).filter((x) => x.sc >= 0).sort((a, b) => b.sc - a.sc).map((x) => x.c);
    const pool = allFiles.length ? allFiles : [];
    if (!term) return pool.slice(0, 40);
    return pool.map((f) => ({ f, sc: score(term, f) })).filter((x) => x.sc >= 0).sort((a, b) => b.sc - a.sc).slice(0, 60).map((x) => x.f);
  }, [isCmd, term, allFiles, cmds]);

  useEffect(() => setHl(0), [q]);
  useEffect(() => { list.current?.querySelector(".hl")?.scrollIntoView({ block: "nearest" }); }, [hl]);

  const choose = (i: number) => {
    const r = rows[i];
    if (!r) return;
    close();
    if (typeof r === "string") void openFile(r);
    else r.run();
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal palette">
        <div className="palette-in">
          {isCmd ? <Command /> : <Search />}
          <input
            autoFocus value={q} placeholder={isCmd ? "Taper une commande…" : "Chercher un fichier par nom…  (> pour les commandes)"}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(h + 1, rows.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(hl); }
            }}
          />
        </div>
        <div className="palette-list" ref={list}>
          {rows.map((r, i) =>
            typeof r === "string" ? (
              <div key={r} className={`it ${i === hl ? "hl" : ""}`} onMouseMove={() => setHl(i)} onClick={() => choose(i)}>
                <FileIcon name={r} /><span>{r.split("/").pop()}</span><small>{r.includes("/") ? r.split("/").slice(0, -1).join("/") : ""}</small>
              </div>
            ) : (
              <div key={r.id} className={`it ${i === hl ? "hl" : ""}`} onMouseMove={() => setHl(i)} onClick={() => choose(i)}>
                <r.icon /><span>{r.label}</span>{r.hint && <small style={{ direction: "ltr" }}>{r.hint}</small>}
              </div>
            ),
          )}
          {!rows.length && <div className="empty">{isCmd ? "Aucune commande." : allFiles.length ? "Aucun fichier." : app?.settings.workspace ? "Indexation…" : "Ouvre d'abord un dossier."}</div>}
        </div>
      </div>
    </div>
  );
}
