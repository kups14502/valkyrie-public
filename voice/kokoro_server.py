#!/usr/bin/env python3
"""Kokoro TTS sidecar for the Valkyrie assistant.

Tiny stdlib HTTP server wrapping kokoro-onnx (same model files slop-factory
uses). The Valkyrie backend proxies /api/assistant/tts here; nothing else
should need to talk to it.

    POST /speak {"text": "...", "voice": "bm_george", "speed": 1.0} -> audio/wav
    GET  /healthz -> {"ok": true}

Env: KOKORO_MODEL, KOKORO_VOICES (paths), BIND (default 127.0.0.1), PORT
(default 8379). Synthesis is serialized with a lock: one laptop CPU, and
overlapping ONNX runs just slow each other down.
"""

import io
import json
import os
import re
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from kokoro_onnx import Kokoro

BIND = os.environ.get("BIND", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8379"))
MODEL = os.environ.get("KOKORO_MODEL", os.path.join(os.path.dirname(__file__), "models", "kokoro-v1.0.int8.onnx"))
VOICES = os.environ.get("KOKORO_VOICES", os.path.join(os.path.dirname(__file__), "models", "voices-v1.0.bin"))
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "bm_george")

MAX_TEXT = 2000
CHUNK_CHARS = 350  # keep each synth call well under kokoro's phoneme limit

print(f"[kokoro] loading model {MODEL}", flush=True)
kokoro = Kokoro(MODEL, VOICES)
lock = threading.Lock()
print(f"[kokoro] ready on {BIND}:{PORT} (default voice {DEFAULT_VOICE})", flush=True)


def split_text(text: str) -> list[str]:
    """Sentence-ish chunks below CHUNK_CHARS so long replies don't hit the
    model's phoneme ceiling; merge tiny fragments forward."""
    parts = re.split(r"(?<=[.!?;:])\s+", text.strip())
    chunks: list[str] = []
    cur = ""
    for p in parts:
        if not p:
            continue
        if len(cur) + len(p) + 1 <= CHUNK_CHARS:
            cur = f"{cur} {p}".strip()
        else:
            if cur:
                chunks.append(cur)
            # single overlong sentence: hard-split on commas/spaces
            while len(p) > CHUNK_CHARS:
                cut = p.rfind(",", 0, CHUNK_CHARS)
                if cut < CHUNK_CHARS // 2:
                    cut = p.rfind(" ", 0, CHUNK_CHARS)
                if cut <= 0:
                    cut = CHUNK_CHARS
                chunks.append(p[:cut].strip())
                p = p[cut:].strip()
            cur = p
    if cur:
        chunks.append(cur)
    return chunks or [text.strip()]


def synth_wav(text: str, voice: str, speed: float) -> bytes:
    lang = "en-gb" if voice.startswith(("bm_", "bf_")) else "en-us"
    pieces = []
    sample_rate = 24000
    gap = None
    with lock:
        for chunk in split_text(text):
            samples, sample_rate = kokoro.create(chunk, voice=voice, speed=speed, lang=lang)
            if gap is None:
                gap = np.zeros(int(sample_rate * 0.12), dtype=samples.dtype)
            pieces.append(samples)
            pieces.append(gap)
    audio = np.concatenate(pieces[:-1]) if len(pieces) > 1 else pieces[0]
    pcm = np.clip(audio * 32767.0, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet: journald gets real errors only
        pass

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            return self._json(200, {"ok": True, "voice": DEFAULT_VOICE})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/speak":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
            text = str(req.get("text", "")).strip()[:MAX_TEXT]
            voice = str(req.get("voice", DEFAULT_VOICE))
            speed = float(req.get("speed", 1.0))
            if not text:
                return self._json(400, {"error": "text required"})
            if not re.fullmatch(r"[a-z]{2}_[a-z]+", voice):
                voice = DEFAULT_VOICE
            speed = min(2.0, max(0.5, speed))
            wav = synth_wav(text, voice, speed)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001 — report, keep serving
            print(f"[kokoro] speak failed: {exc}", flush=True)
            try:
                self._json(500, {"error": str(exc)})
            except Exception:
                pass


if __name__ == "__main__":
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
