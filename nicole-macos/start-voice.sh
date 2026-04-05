#!/bin/bash
# Start both voice servers for Nicole:
#   - Whisper STT on port 8200
#   - Kokoro TTS on port 8201

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WHISPER_MODEL="$SCRIPT_DIR/../models/ggml-large-v3-turbo.bin"

if [ ! -f "$WHISPER_MODEL" ]; then
  echo "Whisper model not found at $WHISPER_MODEL"
  exit 1
fi

cleanup() {
  echo ""
  echo "Shutting down voice servers..."
  kill $WHISPER_PID $KOKORO_PID 2>/dev/null
  wait $WHISPER_PID $KOKORO_PID 2>/dev/null
  echo "Done."
}
trap cleanup EXIT

echo "Starting Whisper STT server (port 8200)..."
whisper-server \
  --model "$WHISPER_MODEL" \
  --port 8200 \
  --threads 4 \
  --language en \
  2>&1 | sed 's/^/[whisper] /' &
WHISPER_PID=$!

echo "Starting Kokoro TTS server (port 8201)..."
python3 "$SCRIPT_DIR/kokoro-server.py" \
  2>&1 | sed 's/^/[kokoro] /' &
KOKORO_PID=$!

echo ""
echo "Voice servers running:"
echo "  Whisper STT → http://127.0.0.1:8200"
echo "  Kokoro TTS  → http://127.0.0.1:8201"
echo ""
echo "Press Ctrl+C to stop both."
echo ""

wait
