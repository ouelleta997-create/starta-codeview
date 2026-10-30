import { useState } from "react";
import { X, KeyRound, Workflow, Bot, Mic, Palette as PaletteIcon, Check, Loader2, Trash2, ExternalLink, ChevronRight } from "lucide-react";
import { useStore } from "../store";
import { api, type AppState } from "../api";

type Section = "providers" | "n8n" | "agent" | "voice" | "appearance";
const NAV: { id: Section; label: string; icon: typeof KeyRound }[] = [
  { id: "providers", label: "Fournisseurs", icon: KeyRound },
  { id: "n8n", label: "n8n", icon: Workflow },
  { id: "agent", label: "Agent", icon: Bot },
  { id: "voice", label: "Voix", icon: Mic },
  { id: "appearance", label: "Apparence", icon: PaletteIcon },
];

function SecretCard({ name, title, badge, children, masked, configured, placeholder, onSaved, extra }: {
  name: string; title: string; badge?: string; children?: React.ReactNode; masked: string; configured: boolean; placeholder: string; onSaved: () => void; extra?: React.ReactNode;
}) {
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);
  const setApp = useStore((s) => s.setApp);

  const save = async () => {
    if (!val.trim()) return;
    setBusy(true);
    try {
      setApp(await api<AppState>("PUT", `/api/secrets/${name}`, { value: val.trim() }));
      setVal("");
      setRes(await api("POST", `/api/test/${name}`));
      onSaved();
    } catch (e) { setRes({ ok: false, message: (e as Error).message }); }
    setBusy(false);
  };
  const test = async () => { setBusy(true); setRes(await api("POST", `/api/test/${name}`)); setBusy(false); };
  const remove = async () => { setApp(await api<AppState>("DELETE", `/api/secrets/${name}`)); setRes(null); onSaved(); };

  return (
    <div className="card">
      <div className="card-h">{title}<span className={`badge ${configured ? "ok" : ""}`}>{configured ? "connecté" : "non configuré"}</span>{badge && <span className="badge">{badge}</span>}</div>
      {children}
      <div className="field">
        <input className="input" type="password" autoComplete="off" spellCheck={false} placeholder={configured ? `${masked} — coller une nouvelle clé pour remplacer` : placeholder} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        <button className="btn primary" disabled={!val.trim() || busy} onClick={() => void save()}>{busy ? <Loader2 className="spin" /> : null}Enregistrer</button>
        {configured && <button className="btn" disabled={busy} onClick={() => void test()}>Tester</button>}
        {configured && <button className="btn danger" onClick={() => void remove()} title="Retirer la clé"><Trash2 /></button>}
      </div>
      {extra}
      {res && <div className={`hint ${res.ok ? "good" : "bad"}`}>{res.ok ? <Check size={12} style={{ verticalAlign: -2 }} /> : null} {res.message}</div>}
    </div>
  );
}

function ProviderCard({ id }: { id: string }) {
  const app = useStore((st) => st.app)!;
  const p = app.providers[id];
  const [open, setOpen] = useState(p.configured);
  const [val, setVal] = useState("");
  const [url, setUrl] = useState(p.baseUrl);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);
  const { setApp, loadModels, patchSettings } = useStore.getState();

  const saveUrl = async (next: string) => {
    const clean = next.trim().replace(/\/+$/, "");
    const urls = { ...app.settings.baseUrls, [id]: clean };
    if (clean === p.defaultBaseUrl) delete urls[id];
    await patchSettings({ baseUrls: urls });
  };
  const connect = async () => {
    if (p.custom && !url.trim()) return setRes({ ok: false, message: "Renseigne d'abord l'adresse du serveur." });
    setBusy(true);
    try {
      if (url.trim().replace(/\/+$/, "") !== p.baseUrl) await saveUrl(url);
      setApp(await api<AppState>("PUT", `/api/secrets/${id}`, { value: val.trim() }));
      setVal("");
      setRes(await api("POST", `/api/test/${id}`));
      void loadModels();
    } catch (e) { setRes({ ok: false, message: (e as Error).message }); }
    setBusy(false);
  };
  const test = async () => { setBusy(true); setRes(await api("POST", `/api/test/${id}`)); setBusy(false); };
  const remove = async () => { setApp(await api<AppState>("DELETE", `/api/secrets/${id}`)); setRes(null); void loadModels(); };

  if (!open)
    return (
      <div className="card compact" onClick={() => setOpen(true)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(true)}>
        <div className="card-h" style={{ margin: 0 }}>{p.label}<span className="badge">{p.keyless ? "local" : p.custom ? "à configurer" : "non configuré"}</span><ChevronRight size={14} style={{ marginLeft: "auto", color: "var(--text3)" }} /></div>
      </div>
    );

  return (
    <div className="card">
      <div className="card-h">{p.label}<span className={`badge ${p.configured ? "ok" : ""}`}>{p.configured ? (p.keyless ? "activé" : "connecté") : "non configuré"}</span>
        {!p.configured && <button className="icon-btn sm" style={{ marginLeft: "auto" }} onClick={() => setOpen(false)} title="Replier"><X /></button>}
      </div>
      {p.presets.length > 0 && (
        <div className="field">
          <select className="input" value={p.baseUrl} onChange={(e) => { setUrl(e.target.value); void saveUrl(e.target.value).then(() => loadModels()); }}>
            {p.presets.map((x) => <option key={x.baseUrl} value={x.baseUrl}>{x.label} — {x.baseUrl}</option>)}
          </select>
        </div>
      )}
      {(p.keyless || p.custom) && (
        <div className="field">
          <input className="input" spellCheck={false} placeholder={p.custom ? "https://mon-serveur.exemple/v1" : p.defaultBaseUrl} value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url.trim().replace(/\/+$/, "") !== p.baseUrl && void saveUrl(url)} />
        </div>
      )}
      <div className="field">
        {!p.keyless && <input className="input" type="password" autoComplete="off" spellCheck={false} placeholder={p.configured && p.masked ? `${p.masked} — coller une nouvelle clé pour remplacer` : p.keyHint || "Clé API"} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void connect()} />}
        <button className="btn primary" disabled={busy || (!p.keyless && !p.custom && !val.trim())} onClick={() => void connect()}>{busy ? <Loader2 className="spin" /> : null}{p.keyless ? (p.configured ? "Enregistrer" : "Activer") : p.custom && !val.trim() ? "Connecter" : "Enregistrer"}</button>
        {p.configured && <button className="btn" disabled={busy} onClick={() => void test()}>Tester</button>}
        {p.configured && <button className="btn danger" onClick={() => void remove()} title={p.keyless ? "Désactiver" : "Retirer la clé"}><Trash2 /></button>}
      </div>
      <div className="hint">
        {p.keyUrl && <a href={p.keyUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{p.keyless ? "Télécharger" : "Obtenir une clé"} <ExternalLink size={10} /></a>}
        {p.baseUrl !== p.defaultBaseUrl && !p.keyless && !p.custom && <> · adresse personnalisée : {p.baseUrl}</>}
        {p.keyless && <> · le serveur doit tourner sur cette machine ; choisis un modèle qui gère les outils.</>}
        {p.custom && <> · n'importe quel serveur qui parle « OpenAI chat completions » (vLLM, LiteLLM, llama.cpp, un proxy d'entreprise…). Clé facultative.</>}
      </div>
      {res && <div className={`hint ${res.ok ? "good" : "bad"}`}>{res.ok ? <Check size={12} style={{ verticalAlign: -2 }} /> : null} {res.message}</div>}
    </div>
  );
}

function Providers() {
  const app = useStore((st) => st.app);
  const [q, setQ] = useState("");
  if (!app) return null;
  const ids = Object.keys(app.providers).filter((id) => !q.trim() || app.providers[id].label.toLowerCase().includes(q.trim().toLowerCase()) || id.includes(q.trim().toLowerCase()));
  const on = ids.filter((id) => app.providers[id].configured);
  const off = ids.filter((id) => !app.providers[id].configured);
  return (
    <>
      <h2>Fournisseurs</h2>
      <p>Tes clés restent sur cette machine, chiffrées (AES-256-GCM). Elles ne sont envoyées qu'au fournisseur concerné. {Object.keys(app.providers).length} fournisseurs, dont les serveurs locaux (Ollama, LM Studio) et n'importe quel serveur compatible OpenAI.</p>
      <div className="field" style={{ marginBottom: 12 }}><input className="input" placeholder="Filtrer les fournisseurs…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {/* Une seule liste à clés stables : une carte qui passe de « Disponibles » à « Connectés » garde son état (message « Clé valide »). */}
      {[
        ...(on.length ? [<h3 key="h-on" className="sub">Connectés</h3>] : []),
        ...on.map((id) => <ProviderCard key={id} id={id} />),
        ...(off.length ? [<h3 key="h-off" className="sub">{on.length ? "Disponibles" : "Choisis un fournisseur"}</h3>] : []),
        ...off.map((id) => <ProviderCard key={id} id={id} />),
      ]}
      {!ids.length && <div className="hint">Aucun fournisseur ne correspond.</div>}
    </>
  );
}

function N8nSection() {
  const { app, refreshWorkflows } = useStore();
  const [url, setUrl] = useState(app?.settings.n8nUrl ?? "");
  const [saved, setSaved] = useState(false);
  if (!app) return null;
  const saveUrl = async () => { await useStore.getState().patchSettings({ n8nUrl: url.trim().replace(/\/+$/, "") }); setSaved(true); setTimeout(() => setSaved(false), 1500); void refreshWorkflows(); };
  return (
    <>
      <h2>n8n</h2>
      <p>Connecte ton instance pour que l'agent crée, modifie et déboguer tes workflows, et pour les éditer toi-même depuis la barre latérale.</p>
      <div className="card">
        <div className="card-h">Adresse de l'instance</div>
        <div className="field">
          <input className="input" placeholder="https://n8n.mondomaine.com" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void saveUrl()} />
          <button className="btn primary" onClick={() => void saveUrl()}>{saved ? <><Check />OK</> : "Enregistrer"}</button>
        </div>
        <div className="hint">Sans « /api/v1 » à la fin.</div>
        {app.settings.n8nUrl && !app.n8n.configured && (
          <div className="hint" style={{ marginTop: 10 }}>
            <b>Étape suivante :</b> <a href={`${app.settings.n8nUrl}/settings/api`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>ouvre la page « n8n API » de ton instance <ExternalLink size={10} /></a>, clique <b>Create an API key</b>, copie la clé, puis colle-la ci-dessous.
          </div>
        )}
      </div>
      <SecretCard name="n8n" title="Clé API n8n" configured={app.n8n.configured || !!app.n8n.masked} masked={app.n8n.masked} placeholder="n8n_api_…" onSaved={() => void refreshWorkflows()}
        extra={<div className="hint">Dans n8n : Paramètres → API → Créer une clé. Active seulement les droits dont tu as besoin.</div>} />
    </>
  );
}

function AgentSection() {
  const { app, patchSettings } = useStore();
  if (!app) return null;
  const a = app.settings.approval;
  return (
    <>
      <h2>Agent</h2>
      <p>Jusqu'où l'agent peut-il aller sans te demander ?</p>
      <label className={`opt ${a === "auto" ? "on" : ""}`}>
        <input type="radio" checked={a === "auto"} onChange={() => void patchSettings({ approval: "auto" })} />
        <div><b>Autonome</b><span>Lit, écrit et exécute seul dans le dossier ouvert. Demande une confirmation uniquement pour le dangereux : suppressions récursives, <code>git push --force</code>, écriture hors du dossier, activation ou suppression d'un workflow n8n.</span></div>
      </label>
      <label className={`opt ${a === "ask" ? "on" : ""}`}>
        <input type="radio" checked={a === "ask"} onChange={() => void patchSettings({ approval: "ask" })} />
        <div><b>Prudent</b><span>Demande avant chaque écriture de fichier, chaque commande et chaque modification n8n. La lecture reste libre.</span></div>
      </label>
      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h">Aucune limite d'étapes</div>
        <div className="hint" style={{ marginTop: 0 }}>L'agent travaille jusqu'au bout sans te demander de dire « continue » : tu peux t'éloigner. Deux filets seulement : il s'arrête si une même action se répète 10 fois de suite, et reprend tout seul une réponse coupée par la limite de sortie du modèle.</div>
      </div>
      <div className="card">
        <div className="card-h">Consignes de projet</div>
        <div className="hint" style={{ marginTop: 0 }}>Si le dossier contient <code>AGENTS.md</code>, <code>CLAUDE.md</code> ou <code>.codeview/rules.md</code>, l'agent le lit à chaque conversation.</div>
      </div>
    </>
  );
}

const VOICE_MODELS: { id: string; label: string; hint: string }[] = [
  { id: "tiny", label: "tiny", hint: "≈ 75 Mo · le plus rapide, approximatif" },
  { id: "base", label: "base", hint: "≈ 145 Mo · rapide, correct en français clair" },
  { id: "small", label: "small", hint: "≈ 480 Mo · bon équilibre (par défaut)" },
  { id: "medium", label: "medium", hint: "≈ 1,5 Go · plus précis, plus lent sur processeur" },
  { id: "large-v3-turbo", label: "large-v3-turbo", hint: "≈ 1,6 Go · le plus précis ; confortable surtout avec une carte NVIDIA" },
];

function VoiceSection() {
  const { app, patchSettings, refreshVoice } = useStore();
  if (!app) return null;
  const v = app.voice;
  const s = app.settings;
  const status = !v.installed ? "non installée" : v.state === "ready" ? "prête" : v.state === "error" ? "en erreur" : v.state === "loading" ? "chargement du modèle…" : "en veille";
  return (
    <>
      <h2>Voix</h2>
      <p>Dicte à chaque conversation avec son bouton micro. La transcription se fait sur ta machine (Whisper, via un petit serveur FastAPI local) : aucun son ne quitte ton ordinateur.</p>
      <div className="card">
        <div className="card-h">Moteur vocal<span className={`badge ${v.state === "ready" ? "ok" : ""}`}>{status}</span></div>
        {!v.installed && <div className="hint" style={{ marginTop: 0 }}>Pour l'installer : double-clic sur <code>Installer-voix.bat</code>, ou <code>npm run voice:install</code> dans le dossier de CodeView, puis relance l'application.</div>}
        {v.installed && v.state === "ready" && <div className="hint" style={{ marginTop: 0 }}>Modèle « {v.model} » sur {v.device === "cuda" ? "carte NVIDIA" : "processeur"}.</div>}
        {v.state === "loading" && <div className="hint" style={{ marginTop: 0 }}>Le tout premier lancement télécharge le modèle ; la suite est instantanée.</div>}
        {v.state === "error" && <div className="hint bad" style={{ marginTop: 0 }}>{v.error}</div>}
        {v.installed && <div className="field" style={{ marginTop: 8 }}><button className="btn" onClick={() => void refreshVoice()}>Actualiser</button></div>}
      </div>
      <div className="card">
        <div className="card-h">Modèle de reconnaissance</div>
        <div className="field">
          <select className="input" value={s.voiceModel} onChange={(e) => void patchSettings({ voiceModel: e.target.value })}>
            {VOICE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.hint}</option>)}
          </select>
        </div>
        <div className="hint">Un modèle plus gros comprend mieux mais met plus de temps. Un modèle jamais utilisé se télécharge à la première dictée.</div>
      </div>
      <div className="card">
        <div className="card-h">Langue parlée</div>
        <div className="field">
          <select className="input" value={s.voiceLang} onChange={(e) => void patchSettings({ voiceLang: e.target.value })}>
            <option value="fr">Français</option>
            <option value="en">Anglais</option>
            <option value="auto">Détection automatique (moins fiable sur les phrases courtes)</option>
          </select>
        </div>
      </div>
      <label className={`opt ${s.voiceAutoSend ? "on" : ""}`}>
        <input type="checkbox" checked={s.voiceAutoSend} onChange={(e) => void patchSettings({ voiceAutoSend: e.target.checked })} />
        <div><b>Envoyer automatiquement ce que je dicte</b><span>Dès que la transcription est prête, le message part à l'agent (s'il travaille déjà, il part dès qu'il a fini). Désactivé : le texte attend dans la zone de saisie, tu l'envoies toi-même.</span></div>
      </label>
      <div className="hint" style={{ marginTop: 12 }}>Clique sur le micro d'une conversation pour parler ; il s'arrête tout seul après environ 2 secondes de silence (ou reclique pour terminer). Un seul micro à la fois.</div>
    </>
  );
}

function Appearance() {
  const { app, patchSettings } = useStore();
  if (!app) return null;
  return (
    <>
      <h2>Apparence</h2>
      <p>Thème de l'interface, de l'éditeur et du terminal.</p>
      {(["dark", "light", "system"] as const).map((t) => (
        <label key={t} className={`opt ${app.settings.theme === t ? "on" : ""}`}>
          <input type="radio" checked={app.settings.theme === t} onChange={() => void patchSettings({ theme: t })} />
          <div><b>{t === "dark" ? "Sombre" : t === "light" ? "Clair" : "Système"}</b></div>
        </label>
      ))}
      <div className="hint" style={{ marginTop: 18 }}>Version {app.version} · données dans <code>{app.dataDir}</code></div>
    </>
  );
}

export function Settings() {
  const section = useStore((s) => s.settings) as Section;
  const close = () => useStore.setState({ settings: false });
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="modal settings" role="dialog" aria-label="Réglages">
        <nav className="set-nav">
          <h3>Réglages</h3>
          {NAV.map((n) => <button key={n.id} className={section === n.id ? "on" : ""} onClick={() => useStore.setState({ settings: n.id })}><n.icon />{n.label}</button>)}
        </nav>
        <div className="set-body">
          <button className="icon-btn x-close" onClick={close} title="Fermer"><X /></button>
          {section === "providers" && <Providers />}
          {section === "n8n" && <N8nSection />}
          {section === "agent" && <AgentSection />}
          {section === "voice" && <VoiceSection />}
          {section === "appearance" && <Appearance />}
        </div>
      </div>
    </div>
  );
}
