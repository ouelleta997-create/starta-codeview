import { spawn, type ChildProcess } from "node:child_process";

// Exécution de commandes locales, partagée entre le terminal de l'utilisateur
// et l'outil run_command des agents. Pas de PTY (zéro module natif) : les
// programmes interactifs ne sont pas supportés, stdin est fermé.

const isWin = process.platform === "win32";
export const SHELL_NAME = isWin ? "PowerShell" : "bash";

export interface RunOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onData?: (chunk: string) => void;
}

export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

const MAX_KEEP = 24000;

export function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * La commande est transmise en base64 puis évaluée : zéro souci de guillemets,
 * et l'encodage UTF-8 est réglé AVANT d'interpréter (les erreurs de syntaxe sortent lisibles).
 * Le code de sortie d'une commande native est propagé.
 */
function psWrapper(command: string): string {
  const b64 = Buffer.from(command, "utf8").toString("base64");
  return `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; $global:LASTEXITCODE=$null; Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))); if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }`;
}

export function runCommand(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = isWin
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", psWrapper(opts.command)]
      : ["-lc", opts.command];
    const child = spawn(isWin ? "powershell.exe" : "bash", args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWin,
      env: { ...process.env, FORCE_COLOR: "1", PYTHONUNBUFFERED: "1", PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    });
    let head = "";
    let tail = "";
    let total = 0;
    let timedOut = false;
    let aborted = false;

    const take = (b: Buffer) => {
      const s = b.toString("utf8");
      total += s.length;
      opts.onData?.(s);
      if (head.length < MAX_KEEP / 3) head += s.slice(0, MAX_KEEP / 3 - head.length);
      tail = (tail + s).slice(-MAX_KEEP);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs ?? 120000);
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, extra = "") => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      let output = total <= MAX_KEEP ? tail : `${head}\n… [${total - MAX_KEEP} caractères omis] …\n${tail.slice(-(MAX_KEEP * 2) / 3)}`;
      output += extra;
      resolve({ code, output: output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""), timedOut, aborted });
    };
    child.on("error", (e) => finish(null, `\n[erreur de lancement : ${e.message}]`));
    child.on("close", (code) => finish(code));
  });
}

/** Commandes qui demandent toujours une confirmation, même en mode autonome. */
const DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bremove-item\b[^\n]*-recurse/i,
  /\b(rd|rmdir)\s+\/s/i,
  /\bdel\s+\/[a-z]*s/i,
  /\bformat(-volume)?\b\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bgit\s+push\b[^\n]*(--force|-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\b(shutdown|restart-computer|stop-computer)\b/i,
  /\b(reg\s+(delete|add)|set-itemproperty\s+hk)/i,
  /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n|]*\|\s*(sh|bash|iex|invoke-expression|powershell)/i,
  /\bnpm\s+publish\b/i,
  /\bdrop\s+(table|database)\b/i,
  /\bchmod\s+-R\s+777\b/,
  /\b(sudo|runas)\b/i,
];

export function isDangerous(command: string): boolean {
  return DANGEROUS.some((r) => r.test(command));
}
