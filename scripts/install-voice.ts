// Installe la dictée vocale : environnement Python isolé + FastAPI + Whisper (local).
//   npm run voice:install                 modèle « small » (≈ 480 Mo à télécharger, une seule fois)
//   npm run voice:install -- --model medium
// Tout vit dans ~/.starta-codeview (voice-venv, voice-models) : supprimer ces dossiers désinstalle la voix.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VOICE_MODELS, VOICE_VENV } from "../server/voice.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const model = arg("model") ?? "small";

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(cmd, args, { stdio: "inherit", env });
}

function findPython(): { cmd: string; args: string[] } | null {
  const candidates = win ? [{ cmd: "py", args: ["-3"] }, { cmd: "python", args: [] }] : [{ cmd: "python3", args: [] }, { cmd: "python", args: [] }];
  for (const c of candidates) {
    const r = spawnSync(c.cmd, [...c.args, "-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"], { stdio: "ignore" });
    if (r.status === 0) return c;
  }
  return null;
}

const py = findPython();
if (!py) {
  console.error("Python 3.9 ou plus récent est introuvable. Installe-le (https://www.python.org/downloads/) puis relance.");
  process.exit(1);
}

const venvPy = path.join(VOICE_VENV, win ? "Scripts/python.exe" : "bin/python");
if (!fs.existsSync(venvPy)) {
  console.log(`\n[1/3] Création de l'environnement Python : ${VOICE_VENV}`);
  if (run(py.cmd, [...py.args, "-m", "venv", VOICE_VENV]).status !== 0) process.exit(1);
} else console.log(`\n[1/3] Environnement Python déjà là : ${VOICE_VENV}`);

console.log("\n[2/3] Installation de FastAPI et faster-whisper…");
if (run(venvPy, ["-m", "pip", "install", "--disable-pip-version-check", "-r", path.join(ROOT, "voice", "requirements.txt")]).status !== 0) process.exit(1);

console.log(`\n[3/3] Téléchargement et vérification du modèle « ${model} »…`);
fs.mkdirSync(VOICE_MODELS, { recursive: true });
const env = { ...process.env, CODEVIEW_VOICE_MODEL: model, CODEVIEW_VOICE_MODELS: VOICE_MODELS, PYTHONUTF8: "1", HF_HUB_DISABLE_TELEMETRY: "1" };
if (run(venvPy, [path.join(ROOT, "voice", "server.py"), "--check"], env).status !== 0) process.exit(1);

console.log(`\nVoix prête. Relance CodeView : le bouton micro de chaque conversation fonctionne.${model !== "small" ? `\nPense à choisir « ${model} » dans Réglages › Voix.` : ""}`);
