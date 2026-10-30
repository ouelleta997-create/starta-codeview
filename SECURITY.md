# Security

Starta CodeView gives AI models a shell and file access on your computer. Treat it like any tool that runs code for you.

## Model

- The server binds to `127.0.0.1` only. Every request needs the per-install token (stored in `~/.starta-codeview/token`, delivered as an `HttpOnly; SameSite=Strict` cookie by the launcher URL). `Host` and, for WebSockets and writes, `Origin` are checked — this blocks drive-by requests from web pages and DNS-rebinding.
- **Do not expose the port** (no tunnel, no `0.0.0.0`, no reverse proxy). Anyone who reaches it with the token can run commands as you.
- File APIs are confined to the open folder. Agent tools can read outside it, but writing outside it requires your approval.
- Dangerous shell patterns always require approval, even in Autonomous mode. This is a **deny-list, not a sandbox**: a determined model (or a prompt injection hidden in a file or web page the agent reads) can work around it. If you open untrusted repositories, use **Cautious** mode.

## Voice

Dictation uses a local FastAPI process (`voice/server.py`) started by CodeView. It binds to `127.0.0.1` on a random port, rejects any request without a per-run token, and exits when CodeView exits. The browser never talks to it directly: audio goes to `/api/voice/transcribe` (same token/Origin checks as every other write), which forwards it. Audio is transcribed in memory and never stored or sent to a third party. The Whisper model is downloaded once from Hugging Face by `npm run voice:install`.

## Keys

API keys are encrypted at rest with AES-256-GCM; the master key sits in `~/.starta-codeview/master.key` (mode 0600 on Unix). **There is no passphrase** — anyone who can read your whole `~/.starta-codeview` folder can decrypt the keys. On Windows the file inherits your user profile's permissions. Use provider-side spending limits and project-scoped keys.

Keys are sent only to the provider they belong to and are never returned by the local API (only a masked form).

## Prompt injection

Text the agent reads (files, n8n execution data, command output) can contain instructions aimed at the model. Cautious mode exists for this reason. Never give an n8n API key more rights than you need.

## Reporting

Open a private security advisory on the GitHub repository, or email the maintainers listed on the repository page. Please don't file public issues for vulnerabilities.
