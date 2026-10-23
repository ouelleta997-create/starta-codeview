# Contributing

```bash
npm install
npm run dev          # server (watch) + Vite on http://127.0.0.1:5173 (open via the URL the server prints)
npm run typecheck
npm test             # end-to-end against a mock provider + mock n8n; no keys, no network
```

- Server code is plain TypeScript run directly by Node (type stripping): no enums, no parameter properties, imports end in `.ts`.
- Keep it small. A feature that needs a native module, an account, or a second runtime is probably out of scope.
- New provider = a few lines in `server/providers.ts` if it speaks OpenAI chat completions. Please add a test.
- UI text is French by default; we welcome an i18n layer.
