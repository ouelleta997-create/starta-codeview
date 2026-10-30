import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";

// Test de bout en bout : vrai serveur CodeView + faux fournisseur compatible
// OpenAI + faux n8n. Aucune clé réelle, aucun accès réseau externe.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cv-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cv-work-"));
const PORT = 5900 + Math.floor(Math.random() * 90);

let server: ChildProcess;
let mock: http.Server;
let mockPort = 0;
let voice: http.Server; // faux moteur vocal (FastAPI) : vérifie le jeton et renvoie un texte fixe
let voicePort = 0;
const VOICE_TOKEN = "test-voice-token";
const voiceCalls: { lang: string | null; bytes: number; type: string | undefined }[] = [];
let cookie = "";
const n8nCalls: { method: string; url: string; body?: any }[] = [];
let script: (messages: any[]) => any = () => ({ text: "ok" });

function sseChunks(res: http.ServerResponse, out: { text?: string; tool?: { name: string; args: object }[]; finish?: string }) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (out.text) for (const w of out.text.match(/.{1,6}/g) ?? []) send({ choices: [{ delta: { content: w } }] });
  (out.tool ?? []).forEach((t, i) => {
    const args = JSON.stringify(t.args);
    send({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${i}`, function: { name: t.name, arguments: args.slice(0, 10) } }] } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(10) } }] } }] });
  });
  send({ choices: [{ delta: {}, finish_reason: out.finish ?? "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  res.write("data: [DONE]\n\n");
  res.end();
}

before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      }
      if (req.url?.startsWith("/v1/chat/completions")) return sseChunks(res, script(JSON.parse(body).messages));
      if (req.url?.startsWith("/n8n/api/v1")) {
        n8nCalls.push({ method: req.method!, url: req.url, body: body ? JSON.parse(body) : undefined });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.method === "GET") return res.end(JSON.stringify({ data: [{ id: "w1", name: "Démo", active: false, nodes: [{}, {}] }] }));
        return res.end(JSON.stringify({ id: "w2", name: "Créé", active: false }));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  mockPort = (mock.address() as { port: number }).port;

  voice = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const json = (code: number, o: unknown) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(o));
      if (req.headers["x-voice-token"] !== VOICE_TOKEN) return json(401, { detail: "Jeton refusé." });
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/health") return json(200, { status: "ready", error: "", device: "cpu", model: "fake" });
      if (u.pathname === "/transcribe") {
        voiceCalls.push({ lang: u.searchParams.get("lang"), bytes: Buffer.concat(chunks).length, type: req.headers["content-type"] });
        return json(200, { text: "bonjour agent", language: "fr", seconds: 1, ms: 5 });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => voice.listen(0, "127.0.0.1", r));
  voicePort = (voice.address() as { port: number }).port;

  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ workspace: work, baseUrls: { zai: `http://127.0.0.1:${mockPort}/v1` }, n8nUrl: `http://127.0.0.1:${mockPort}/n8n` }));
  server = spawn(process.execPath, ["server/index.ts", "--no-open"], { env: { ...process.env, CODEVIEW_HOME: home, PORT: String(PORT), CODEVIEW_VOICE_URL: `http://127.0.0.1:${voicePort}`, CODEVIEW_VOICE_TOKEN: VOICE_TOKEN }, stdio: "pipe" });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("serveur non démarré")), 15000);
    server.stdout!.on("data", (d) => String(d).includes("→") && (clearTimeout(t), resolve()));
    server.stderr!.on("data", (d) => process.stderr.write(d));
  });
  const token = fs.readFileSync(path.join(home, "token"), "utf8").trim();
  const r = await fetch(`http://127.0.0.1:${PORT}/?t=${token}`, { redirect: "manual" });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
});

after(() => {
  server?.kill();
  mock?.close();
  voice?.close();
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, { ...init, headers: { cookie, "Content-Type": "application/json", Origin: `http://127.0.0.1:${PORT}`, ...(init.headers ?? {}) } });

function chat(text: string, approve?: (e: any) => boolean): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, Origin: `http://127.0.0.1:${PORT}` } });
    const events: any[] = [];
    ws.on("open", () => ws.send(JSON.stringify({ type: "chat", text, model: { provider: "zai", id: "mock-model" } })));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type !== "chat.event") return;
      events.push(m.event);
      if (m.event.type === "approval") ws.send(JSON.stringify({ type: "approve", id: m.event.id, allow: approve ? approve(m.event) : true }));
      if (m.event.type === "done") (ws.close(), resolve(events));
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("délai dépassé")), 20000);
  });
}

test("sans jeton : accès refusé", async () => {
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/state`)).status, 401);
});

test("WebSocket refusé depuis une autre origine", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, Origin: "http://evil.example" } });
  const code = await new Promise((r) => {
    ws.on("unexpected-response", (_q, res) => r(res.statusCode));
    ws.on("error", () => r("err"));
    ws.on("open", () => r("open"));
  });
  assert.notEqual(code, "open");
});

test("enregistrer une clé, la masquer, tester le fournisseur", async () => {
  const s = await (await api("/api/secrets/zai", { method: "PUT", body: JSON.stringify({ value: "sk-test-1234567890abcdef" }) })).json();
  assert.equal(s.providers.zai.configured, true);
  assert.match(s.providers.zai.masked, /^sk-t•+cdef$/);
  assert.ok(!JSON.stringify(s).includes("1234567890"));
  assert.ok(!fs.readFileSync(path.join(home, "secrets.json"), "utf8").includes("sk-test"));
  const t = await (await api("/api/test/zai", { method: "POST", body: "{}" })).json();
  assert.equal(t.ok, true);
});

test("l'agent écrit un fichier, lance une commande, répond", async () => {
  let turn = 0;
  script = () =>
    [
      { tool: [{ name: "write_file", args: { path: "src/hello.txt", content: "bonjour" } }] },
      { tool: [{ name: "run_command", args: { command: "echo salut-terminal" } }] },
      { text: "Terminé." },
    ][turn++];
  const ev = await chat("fais le truc");
  assert.equal(fs.readFileSync(path.join(work, "src/hello.txt"), "utf8"), "bonjour");
  const res = ev.filter((e) => e.type === "tool_result");
  assert.equal(res.length, 2);
  assert.match(res[1].content, /salut-terminal/);
  assert.match(res[1].content, /code de sortie 0/);
  assert.equal(ev.at(-1).reason, "end");
  assert.ok(ev.some((e) => e.type === "usage" && e.input === 11));
});

test("edit_file : unicité et remplacement", async () => {
  fs.writeFileSync(path.join(work, "a.txt"), "un deux un");
  let turn = 0;
  script = () =>
    [
      { tool: [{ name: "edit_file", args: { path: "a.txt", old_string: "un", new_string: "1" } }] },
      { tool: [{ name: "edit_file", args: { path: "a.txt", old_string: "deux", new_string: "2" } }] },
      { text: "fin" },
    ][turn++];
  const ev = await chat("édite");
  const res = ev.filter((e) => e.type === "tool_result");
  assert.equal(res[0].isError, true);
  assert.match(res[0].content, /2 fois/);
  assert.equal(fs.readFileSync(path.join(work, "a.txt"), "utf8"), "un 2 un");
});

test("commande destructrice : approbation exigée, refus respecté", async () => {
  fs.mkdirSync(path.join(work, "precieux"));
  fs.writeFileSync(path.join(work, "precieux/x.txt"), "x");
  let turn = 0;
  script = () => [{ tool: [{ name: "run_command", args: { command: "rm -rf precieux" } }] }, { text: "ok" }][turn++];
  const ev = await chat("nettoie", () => false);
  assert.ok(ev.some((e) => e.type === "approval"));
  assert.ok(fs.existsSync(path.join(work, "precieux/x.txt")));
  assert.match(ev.find((e) => e.type === "tool_result").content, /refusé/);
});

test("écriture hors de l'espace de travail : approbation exigée", async () => {
  let turn = 0;
  const outside = path.join(os.tmpdir(), `cv-out-${Date.now()}.txt`);
  script = () => [{ tool: [{ name: "write_file", args: { path: outside, content: "x" } }] }, { text: "ok" }][turn++];
  const ev = await chat("écris dehors", () => false);
  assert.ok(ev.some((e) => e.type === "approval" && /hors de l'espace/.test(e.title)));
  assert.ok(!fs.existsSync(outside));
});

test("n8n : outils disponibles, création via l'API", async () => {
  await api("/api/secrets/n8n", { method: "PUT", body: JSON.stringify({ value: "n8n-key" }) });
  let turn = 0;
  script = () =>
    [
      { tool: [{ name: "n8n_list_workflows", args: {} }] },
      { tool: [{ name: "n8n_create_workflow", args: { workflow: { name: "Créé", nodes: [], connections: {}, id: "doit-être-retiré", active: true } } }] },
      { text: "fait" },
    ][turn++];
  const ev = await chat("workflows");
  const res = ev.filter((e) => e.type === "tool_result");
  assert.match(res[0].content, /Démo/);
  assert.match(res[1].content, /id=w2/);
  const post = n8nCalls.find((c) => c.method === "POST");
  assert.deepEqual(Object.keys(post!.body).sort(), ["connections", "name", "nodes", "settings"]);
});

test("fichiers : lecture, écriture, évasion de chemin refusée", async () => {
  const w = await api("/api/fs/file", { method: "PUT", body: JSON.stringify({ path: "z/y.md", content: "# salut" }) });
  assert.equal(w.status, 200);
  const r = await (await api("/api/fs/file?path=z/y.md")).json();
  assert.equal(r.content, "# salut");
  assert.equal((await api("/api/fs/file?path=../../etc/passwd")).status, 403);
});

test("conversation persistée", async () => {
  const list = await (await api("/api/chats")).json();
  assert.ok(list.length >= 4);
});

test("aucune limite d'étapes : 60 tours d'outils d'affilée, sans « continue »", async () => {
  let turn = 0;
  script = () => (turn++ < 60 ? { tool: [{ name: "list_dir", args: { path: ".", depth: turn } }] } : { text: "Tout est fait." });
  const ev = await chat("travaille longtemps");
  assert.equal(ev.filter((e) => e.type === "tool_result").length, 60);
  assert.equal(ev.at(-1).reason, "end");
  assert.ok(!ev.some((e) => e.type === "error"));
});

test("boucle : la même action répétée 10 fois arrête l'agent", async () => {
  script = () => ({ tool: [{ name: "list_dir", args: { path: "." } }] });
  const ev = await chat("boucle");
  assert.equal(ev.at(-1).reason, "loop");
  assert.match(ev.find((e) => e.type === "error").message, /Boucle détectée/);
  assert.equal(ev.filter((e) => e.type === "tool_result").length, 9);
});

test("réponse coupée par la limite de sortie : reprise automatique", async () => {
  const seen: any[][] = [];
  let turn = 0;
  script = (messages) => {
    seen.push(messages);
    return [{ text: "Première moitié, ", finish: "length" }, { text: "seconde moitié." }][turn++];
  };
  const ev = await chat("long texte");
  assert.equal(seen.length, 2);
  assert.match(seen[1].at(-1).content, /Reprends exactement/);
  assert.equal(ev.filter((e) => e.type === "text").map((e) => e.delta).join(""), "Première moitié, seconde moitié.");
  assert.equal(ev.at(-1).reason, "end");
});

test("voix : transcription via le moteur local, jeton transmis, état exposé", async () => {
  const st = await (await api("/api/state")).json();
  assert.equal(st.voice.installed, true);
  assert.equal(st.settings.voiceAutoSend, false);
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40)]);
  const r = await api("/api/voice/transcribe?lang=fr", { method: "POST", body: wav, headers: { "Content-Type": "audio/wav" } });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.text, "bonjour agent");
  assert.deepEqual(voiceCalls.at(-1), { lang: "fr", bytes: wav.length, type: "audio/wav" });
  assert.equal((await (await api("/api/voice/status")).json()).state, "ready");
});

test("voix : refusée sans jeton local ou depuis une autre origine", async () => {
  const body = Buffer.alloc(100);
  const noCookie = await fetch(`http://127.0.0.1:${PORT}/api/voice/transcribe`, { method: "POST", body, headers: { Origin: `http://127.0.0.1:${PORT}` } });
  assert.equal(noCookie.status, 401);
  const evil = await api("/api/voice/transcribe", { method: "POST", body, headers: { Origin: "http://evil.example" } });
  assert.equal(evil.status, 403);
});

test("réglages vocaux : modifiables, les inconnus ignorés", async () => {
  const s = await (await api("/api/settings", { method: "PUT", body: JSON.stringify({ voiceAutoSend: true, voiceLang: "en", maxSteps: 5, bidon: 1 }) })).json();
  assert.equal(s.settings.voiceAutoSend, true);
  assert.equal(s.settings.voiceLang, "en");
  assert.ok(!("maxSteps" in s.settings) && !("bidon" in s.settings));
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ voiceAutoSend: false, voiceLang: "fr" }) });
});
