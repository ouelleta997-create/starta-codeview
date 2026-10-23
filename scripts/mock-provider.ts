// Faux fournisseur compatible OpenAI pour tester l'interface sans clé ni crédit.
//   node scripts/mock-provider.ts [port]   puis, dans Réglages, adresse Z.ai = http://127.0.0.1:<port>/v1
import http from "node:http";

const port = Number(process.argv[2]) || 5799;
const plan: ((n: number) => { tool?: { name: string; args: object }; text?: string })[] = [
  () => ({ tool: { name: "list_dir", args: { path: ".", depth: 1 } } }),
  () => ({ tool: { name: "read_file", args: { path: "package.json" } } }),
  () => ({ tool: { name: "write_file", args: { path: "NOTES.md", content: "# Notes\n\nÉcrit par l'agent de démonstration.\n" } } }),
  () => ({ tool: { name: "edit_file", args: { path: "NOTES.md", old_string: "démonstration", new_string: "démo (mock)" } } }),
  () => ({ tool: { name: "run_command", args: { command: "echo bonjour depuis le terminal; node -v" } } }),
  () => ({ text: "J'ai exploré le dossier, lu `package.json`, créé **NOTES.md**, puis fait une retouche et lancé une commande.\n\n```ts\nexport const salut = (nom: string) => `Bonjour ${nom}`;\n```\n\n- tout est vérifié\n- rien d'autre à faire" }),
];

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.endsWith("/models")) return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "demo-agent" }, { id: "demo-agent-2" }] }));
    if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
    const msgs = JSON.parse(body).messages as { role: string }[];
    let lastUser = msgs.length - 1;
    while (lastUser >= 0 && msgs[lastUser].role !== "user") lastUser--;
    const step = msgs.slice(lastUser + 1).filter((m) => m.role === "tool").length;
    const out = plan[Math.min(step, plan.length - 1)](step);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    let t = 0;
    const emit = () => {
      if (out.text) {
        const chunk = out.text.slice(t, t + 7);
        if (chunk) { send({ choices: [{ delta: { content: chunk } }] }); t += 7; return setTimeout(emit, 15); }
      } else if (out.tool && t === 0) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${step}`, function: { name: out.tool.name, arguments: JSON.stringify(out.tool.args) } }] } }] });
      }
      send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1200 + step * 300, completion_tokens: 80 } });
      res.write("data: [DONE]\n\n");
      res.end();
    };
    setTimeout(emit, 250);
  });
}).listen(port, "127.0.0.1", () => console.log(`Faux fournisseur sur http://127.0.0.1:${port}/v1`));
