"""Moteur vocal local de Starta CodeView : FastAPI + faster-whisper.

Reçoit un enregistrement (WAV 16 bits) et renvoie le texte. Rien ne quitte la
machine : le modèle Whisper tourne en local (CPU, ou GPU NVIDIA s'il y en a un).

Lancé automatiquement par CodeView (voir server/voice.ts). Peut aussi tourner seul :
    CODEVIEW_VOICE_TOKEN=secret python voice/server.py --port 5758
puis CODEVIEW_VOICE_URL=http://127.0.0.1:5758 CODEVIEW_VOICE_TOKEN=secret npm start
"""

from __future__ import annotations

import argparse
import hmac
import io
import os
import sys
import threading
import time
import wave

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool

SAMPLE_RATE = 16000
MAX_SECONDS = 600

TOKEN = os.environ.get("CODEVIEW_VOICE_TOKEN", "")
MODEL_NAME = os.environ.get("CODEVIEW_VOICE_MODEL", "small")
MODELS_DIR = os.environ.get("CODEVIEW_VOICE_MODELS") or None
# Un peu de vocabulaire du métier aide Whisper à bien écrire les noms propres.
HINT = os.environ.get(
    "CODEVIEW_VOICE_PROMPT",
    "Conversation de programmation avec un assistant IA : Starta, CodeView, n8n, Claude, GitHub, "
    "Supabase, Hostinger, TypeScript, Python, FTP, API.",
)

# Phrases que Whisper « entend » dans le silence ou le bruit de fond.
HALLUCINATIONS = {
    "merci.",
    "merci",
    "merci d'avoir regardé cette vidéo.",
    "merci d'avoir regardé cette vidéo !",
    "sous-titres réalisés par la communauté d'amara.org",
    "sous-titrage st' 501",
    "sous-titrage société radio-canada",
    "thanks for watching!",
    "thank you.",
    "you",
}

state: dict = {"status": "loading", "error": "", "device": "", "model": MODEL_NAME}
_model = None
_lock = threading.Lock()


def load_model() -> None:
    """Charge Whisper (télécharge le modèle au tout premier lancement)."""
    global _model
    try:
        from faster_whisper import WhisperModel

        device, compute = "cpu", "int8"
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                device, compute = "cuda", "float16"
        except Exception:
            pass
        _model = WhisperModel(
            MODEL_NAME,
            device=device,
            compute_type=compute,
            download_root=MODELS_DIR,
            cpu_threads=min(8, os.cpu_count() or 4),
        )
        state.update(status="ready", device=device, error="")
    except Exception as e:  # noqa: BLE001 — on veut montrer n'importe quelle cause à l'utilisateur
        state.update(status="error", error=f"{type(e).__name__}: {e}")


def decode_audio(data: bytes) -> np.ndarray:
    """WAV PCM 16 bits, mono ou stéréo, à n'importe quelle fréquence (l'interface envoie du 16 kHz mono)."""
    if data[:4] != b"RIFF":
        raise ValueError("format non pris en charge : WAV 16 bits attendu")
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2:
            raise ValueError("WAV 16 bits attendu")
        channels, rate = w.getnchannels(), w.getframerate()
        raw = w.readframes(w.getnframes())
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm[: len(pcm) - len(pcm) % channels].reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE and len(pcm):
        n = int(len(pcm) * SAMPLE_RATE / rate)
        pcm = np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


def transcribe_audio(audio: np.ndarray, lang: str) -> dict:
    started = time.perf_counter()
    seconds = len(audio) / SAMPLE_RATE
    if seconds < 0.3:
        return {"text": "", "language": lang, "seconds": seconds, "ms": 0}
    with _lock:  # une transcription à la fois : les quatre micros se partagent le même processeur
        segments, info = _model.transcribe(
            audio,
            language=None if lang in ("", "auto") else lang,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,
            initial_prompt=HINT,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    if text.lower() in HALLUCINATIONS:
        text = ""
    return {"text": text, "language": info.language, "seconds": round(seconds, 2), "ms": int((time.perf_counter() - started) * 1000)}


def authorize(token: str | None) -> None:
    if TOKEN and not hmac.compare_digest(token or "", TOKEN):
        raise HTTPException(status_code=401, detail="Jeton refusé.")


app = FastAPI(title="CodeView Voice", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health(x_voice_token: str | None = Header(default=None)) -> dict:
    authorize(x_voice_token)
    return state


@app.post("/transcribe")
async def transcribe(request: Request, lang: str = Query(default="fr"), x_voice_token: str | None = Header(default=None)) -> dict:
    authorize(x_voice_token)
    if state["status"] == "error":
        raise HTTPException(status_code=500, detail=state["error"])
    if state["status"] != "ready":
        raise HTTPException(status_code=503, detail="Le modèle vocal se charge encore.")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Enregistrement vide.")
    try:
        audio = await run_in_threadpool(decode_audio, data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Audio illisible : {e}") from e
    if len(audio) > MAX_SECONDS * SAMPLE_RATE:
        raise HTTPException(status_code=413, detail=f"Enregistrement trop long (max {MAX_SECONDS} s).")
    return await run_in_threadpool(transcribe_audio, audio, lang)


def watch_parent() -> None:
    """CodeView nous lance avec un tuyau stdin : s'il se ferme, le parent est mort — on s'arrête."""
    try:
        while sys.stdin.buffer.read(1024):
            pass
    except Exception:  # noqa: BLE001
        pass
    os._exit(0)


def main() -> None:
    ap = argparse.ArgumentParser(description="Moteur vocal local de Starta CodeView")
    ap.add_argument("--port", type=int, default=int(os.environ.get("CODEVIEW_VOICE_PORT", "5758")))
    ap.add_argument("--check", action="store_true", help="charger le modèle, transcrire 1 s de silence, quitter")
    args = ap.parse_args()

    if args.check:
        load_model()
        if state["status"] != "ready":
            print(f"ÉCHEC : {state['error']}")
            sys.exit(1)
        out = transcribe_audio(np.zeros(SAMPLE_RATE * 2, dtype=np.float32), "fr")
        print(f"OK — modèle « {MODEL_NAME} » prêt sur {state['device']} ({out['ms']} ms pour 2 s de silence).")
        return

    import uvicorn

    if os.environ.get("CODEVIEW_VOICE_WATCH_PARENT") == "1":
        threading.Thread(target=watch_parent, daemon=True).start()
    threading.Thread(target=load_model, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
