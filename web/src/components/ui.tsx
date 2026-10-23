import { useEffect, useRef, useState, type ReactNode } from "react";
import { File, FileCode2, FileJson, FileText, Folder, FolderOpen, Image, Settings2, TerminalSquare, Braces, Database, Lock } from "lucide-react";

export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="15" fill="var(--bg2)" stroke="var(--line)" />
      <path d="M22 20 10 32l12 12M42 20l12 12-12 12" fill="none" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M36 15 28 49" stroke="var(--text)" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

const EXT_COLOR: Record<string, string> = {
  ts: "#4a9eff", tsx: "#4a9eff", js: "#e8c547", jsx: "#e8c547", mjs: "#e8c547", json: "#e8a547", py: "#5aa9e6", rs: "#e07a4f", go: "#5ec3d8",
  html: "#e5734f", css: "#8f7cf0", scss: "#d86ba8", md: "#9aa5b1", astro: "#ff6f3c", php: "#8892bf", sql: "#d9a05b", yml: "#e06c75", yaml: "#e06c75",
  sh: "#7ec97e", ps1: "#4d8fd6", env: "#e5c07b", svg: "#e5a54f", java: "#d9825b", cs: "#8a6bd8", cpp: "#5b8fd9", c: "#5b8fd9", vue: "#41b883",
};

export function FileIcon({ name, dir, open }: { name: string; dir?: boolean; open?: boolean }) {
  if (dir) return open ? <FolderOpen style={{ color: "var(--text3)" }} /> : <Folder style={{ color: "var(--text3)" }} />;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const color = EXT_COLOR[ext] ?? "var(--text3)";
  const Cmp = ["png", "jpg", "jpeg", "gif", "webp", "ico", "svg"].includes(ext) ? Image
    : ext === "json" ? FileJson
    : ["md", "txt", "rst"].includes(ext) ? FileText
    : ["sh", "ps1", "bat", "cmd"].includes(ext) ? TerminalSquare
    : ["sql", "db", "sqlite"].includes(ext) ? Database
    : ["env", "lock"].includes(ext) || name.startsWith(".env") ? Lock
    : ["yml", "yaml", "toml", "ini", "conf"].includes(ext) ? Settings2
    : ["css", "scss", "html"].includes(ext) ? Braces
    : ext ? FileCode2 : File;
  return <Cmp style={{ color }} />;
}

export function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOut(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onOut(); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [active, onOut, ref]);
}

/** Bouton + menu déroulant ancré. */
export function Dropdown({ trigger, children, up, align = "left", className = "" }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; up?: boolean; align?: "left" | "right"; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  return (
    <div className={`anchor ${className}`} ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && <div className={`menu ${up ? "up" : "down"}`} style={align === "right" ? { right: 0 } : { left: 0 }}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function usePersisted(key: string, initial: number): [number, (n: number) => void] {
  const [v, setV] = useState(() => { try { const n = Number(localStorage.getItem(key)); return n > 0 ? n : initial; } catch { return initial; } });
  return [v, (n) => { setV(n); try { localStorage.setItem(key, String(n)); } catch { /* stockage indisponible */ } }];
}

export function Resizer({ onDrag, horizontal }: { onDrag: (delta: number) => void; horizontal?: boolean }) {
  const [drag, setDrag] = useState(false);
  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    setDrag(true);
    let last = horizontal ? e.clientY : e.clientX;
    const move = (m: MouseEvent) => { const p = horizontal ? m.clientY : m.clientX; onDrag(p - last); last = p; };
    const up = () => { setDrag(false); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    document.body.style.cursor = horizontal ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return <div className={`resizer ${horizontal ? "h" : ""} ${drag ? "drag" : ""}`} onMouseDown={start} />;
}
