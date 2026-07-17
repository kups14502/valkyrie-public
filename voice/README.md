# Valkyrie voice services

Two local-only services power the assistant's voice on odin. The backend
proxies them at `/api/assistant/stt` and `/api/assistant/tts`; nothing else
talks to them directly.

| service | what | port | unit |
|---|---|---|---|
| STT | whisper.cpp `whisper-server`, model `small.en-q5_1` | 127.0.0.1:8378 | `whisper-stt.service` (user) |
| TTS | `kokoro_server.py` (kokoro-onnx int8, voices incl. `bm_george`) | 127.0.0.1:8379 | `valkyrie-tts.service` (user) |

## Setup (odin)

```bash
# STT: build whisper.cpp once and fetch the model
git clone https://github.com/ggml-org/whisper.cpp ~/whisper.cpp
cmake -S ~/whisper.cpp -B ~/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build ~/whisper.cpp/build -j --target whisper-server
bash ~/whisper.cpp/models/download-ggml-model.sh small.en-q5_1 ~/whisper.cpp/models

# TTS: venv + model files (copied from slop-factory; ~150 MB, gitignored)
cd ~/valkyrie/voice
python -m venv venv && venv/bin/pip install -r requirements.txt
mkdir -p models
cp ~/slop-factory/kokoro-v1.0.int8.onnx models/
cp ~/slop-factory/voices-v1.0.bin models/

# units
mkdir -p ~/.config/systemd/user
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now whisper-stt.service valkyrie-tts.service
```

Smoke test:

```bash
curl -s http://127.0.0.1:8379/healthz
curl -s -X POST http://127.0.0.1:8379/speak -H 'Content-Type: application/json' \
  -d '{"text":"Huginn online."}' -o /tmp/tts.wav && aplay /tmp/tts.wav
curl -s http://127.0.0.1:8378/inference -F file=@/tmp/tts.wav -F response_format=json
```
