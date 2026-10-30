# Contributing

```bash
npm install
npm run dev          # server (watch) + Vite on http://127.0.0.1:5173 (open via the URL the server prints)
npm run typecheck
npm test             # end-to-end against a mock provider + mock n8n; no keys, no network
```

- Server code is plain TypeScript run directly by Node (type stripping): no enums, no parameter properties, imports end in `.ts`.
- Keep it small. A feature that needs a native module, an account, or a second runtime is probably out of scope.
- **New provider** = one entry in `PROVIDERS` in `server/providers.ts` if it speaks OpenAI chat completions (`label`, `baseUrl`, `keyUrl`, `fallbackModels`; optional `presets`, `keyless`, `streamUsage`, `extraHeaders`, `stripModelPrefix`, `publicModels` — see the `ProviderDef` comments). Before opening a PR, check the URL for real: `curl -i <baseUrl>/models` should answer 401/403 (not 404 or a DNS error). Please say in the PR whether you tried it with a real key.
- **UI text is French only** today. An i18n layer (and an English translation) is the most wanted contribution: keep strings out of logic and we'll thank you.
- The voice engine (`voice/server.py`, FastAPI + faster-whisper) is optional and Python-only; the Node side lives in `server/voice.ts`. Keep it optional.
