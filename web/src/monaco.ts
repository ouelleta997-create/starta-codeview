import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// Sans projet TypeScript chargé, les erreurs sémantiques (imports introuvables…) ne sont que du bruit.
const ts = (monaco.languages as any).typescript;
for (const d of [ts?.typescriptDefaults, ts?.javascriptDefaults]) {
  d?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  d?.setCompilerOptions({ allowNonTsExtensions: true, allowJs: true, target: 99, jsx: 4 });
}

const common = {
  "editorCursor.foreground": "#2fbf8f",
  "editorLineNumber.foreground": "#5a5a5a",
  "editor.selectionBackground": "#2fbf8f33",
  "editorWidget.border": "#333333",
};
monaco.editor.defineTheme("cv-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6b7280", fontStyle: "italic" },
    { token: "keyword", foreground: "c792ea" },
    { token: "string", foreground: "a5d6a7" },
    { token: "number", foreground: "f4a261" },
    { token: "type", foreground: "7fdbca" },
  ],
  colors: {
    ...common,
    "editor.background": "#181818",
    "editor.lineHighlightBackground": "#1f1f1f",
    "editorLineNumber.activeForeground": "#a3a3a3",
    "editorGutter.background": "#181818",
    "editorIndentGuide.background1": "#262626",
    "editorWidget.background": "#1f1f1f",
    "editorSuggestWidget.background": "#1f1f1f",
    "scrollbarSlider.background": "#33333388",
    "minimap.background": "#181818",
  },
});
monaco.editor.defineTheme("cv-light", {
  base: "vs",
  inherit: true,
  rules: [{ token: "comment", foreground: "8a8f98", fontStyle: "italic" }],
  colors: { ...common, "editorCursor.foreground": "#12936b", "editor.background": "#ffffff", "editor.lineHighlightBackground": "#f6f6f6", "editorLineNumber.foreground": "#b0b0b0" },
});

export const themeName = (t: "dark" | "light") => (t === "dark" ? "cv-dark" : "cv-light");

// ── Modèles (un par onglet) ──

const models = new Map<string, monaco.editor.ITextModel>();
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

const extToLang = new Map<string, string>();
for (const l of monaco.languages.getLanguages()) for (const e of l.extensions ?? []) extToLang.set(e.toLowerCase(), l.id);
const nameToLang: Record<string, string> = { dockerfile: "dockerfile", makefile: "plaintext", ".env": "ini", ".gitignore": "ini" };

export function languageFor(file: string): string {
  const base = file.split(/[\\/]/).pop()!.toLowerCase();
  if (nameToLang[base]) return nameToLang[base];
  const i = base.lastIndexOf(".");
  return (i >= 0 && extToLang.get(base.slice(i))) || "plaintext";
}

/** « ts », « js », « sh »… → identifiant de langage Monaco. */
export function resolveLang(l: string): string {
  const x = l.toLowerCase();
  const hit = monaco.languages.getLanguages().find((g) => g.id === x || g.aliases?.some((a) => a.toLowerCase() === x) || g.extensions?.includes(`.${x}`));
  return hit?.id ?? "";
}

export function ensureModel(id: string, content: string, language: string): monaco.editor.ITextModel {
  let m = models.get(id);
  if (!m || m.isDisposed()) {
    m = monaco.editor.createModel(content, language, monaco.Uri.parse(`cv://model/${encodeURIComponent(id)}`));
    models.set(id, m);
  }
  return m;
}

export const getModel = (id: string) => models.get(id);
export const getValue = (id: string) => models.get(id)?.getValue();

let external = false;
export const isExternalUpdate = () => external;

/** Met à jour le contenu depuis le disque sans marquer l'onglet comme modifié. */
export function setValue(id: string, content: string) {
  const m = models.get(id);
  if (!m || m.getValue() === content) return;
  external = true;
  try { m.setValue(content); } finally { external = false; }
}

export function disposeModel(id: string) {
  models.get(id)?.dispose();
  models.delete(id);
  viewStates.delete(id);
}

export const saveViewState = (id: string, s: monaco.editor.ICodeEditorViewState | null) => void viewStates.set(id, s);
export const getViewState = (id: string) => viewStates.get(id) ?? null;

// ── Éditeur actif (pour lire la sélection depuis le panneau agent) ──

let current: monaco.editor.IStandaloneCodeEditor | null = null;
export const setCurrentEditor = (e: monaco.editor.IStandaloneCodeEditor | null) => void (current = e);

export function getSelectionText(): string {
  if (!current) return "";
  const sel = current.getSelection();
  const model = current.getModel();
  return sel && model && !sel.isEmpty() ? model.getValueInRange(sel) : "";
}

export function revealLine(line: number) {
  if (!current) return;
  current.revealLineInCenter(line);
  current.setPosition({ lineNumber: line, column: 1 });
  current.focus();
}

export { monaco };
