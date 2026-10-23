// Pont entre le store (qui reçoit la sortie des commandes) et le composant xterm.
// Garde un tampon pour rejouer l'historique quand le panneau est (ré)ouvert.

type Sink = (data: string) => void;
let sink: Sink | null = null;
let buffer: string[] = [];
let size = 0;
let cwdOf: () => string = () => "";
const exitListeners = new Set<() => void>();

export function writeTerminal(data: string) {
  buffer.push(data);
  size += data.length;
  while (size > 300_000 && buffer.length > 1) size -= buffer.shift()!.length;
  sink?.(data);
}

export function attachTerminal(s: Sink | null) {
  sink = s;
  if (s) for (const chunk of buffer) s(chunk);
}

export const terminalIsEmpty = () => buffer.length === 0;
export function clearTerminalBuffer() { buffer = []; size = 0; }
export function setCwdProvider(f: () => string) { cwdOf = f; }

export function writePrompt() {
  const cwd = cwdOf();
  writeTerminal(`\r\n\x1b[38;5;78m${cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd}\x1b[0m \x1b[2m❯\x1b[0m `);
}

export function onCommandExit(cb: () => void) { exitListeners.add(cb); return () => void exitListeners.delete(cb); }
export function notifyExit() { for (const cb of exitListeners) cb(); }
