#!/bin/bash
# Start everything Nicole needs:
#   1. Docker (PostgreSQL + SearXNG)
#   2. Whisper STT (port 8200)
#   3. Kokoro TTS (port 8201)
#   4. Nicole server (port 3000)

set -e

NICOLE_DIR="$(cd "$(dirname "$0")" && pwd)"
WHISPER_MODEL="$NICOLE_DIR/models/ggml-large-v3-turbo.bin"

# --- Preflight checks ---

if [ ! -f "$WHISPER_MODEL" ]; then
  echo "Whisper model not found at $WHISPER_MODEL"
  exit 1
fi

if ! command -v whisper-server &>/dev/null; then
  echo "whisper-server not found. Install via: brew install whisper-cpp"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "python3 not found."
  exit 1
fi

# --- Start Docker containers ---

echo "Starting Docker containers..."
if ! docker info &>/dev/null; then
  open -a Docker
  echo "Waiting for Docker to start..."
  for i in $(seq 1 30); do
    docker info &>/dev/null && break
    sleep 1
  done
  if ! docker info &>/dev/null; then
    echo "Docker didn't start in time."
    exit 1
  fi
fi

cd "$NICOLE_DIR"
docker compose up -d 2>&1 | grep -v "Pulling\|Download\|Waiting\|Verifying"

# Wait for PostgreSQL to accept connections
echo "Waiting for PostgreSQL..."
for i in $(seq 1 15); do
  docker exec nicole-db-1 pg_isready -U nicole -q 2>/dev/null && break
  sleep 1
done

# --- Cleanup on exit ---

cleanup() {
  echo ""
  echo "Shutting down Nicole..."
  kill $WHISPER_PID $KOKORO_PID $SERVER_PID 2>/dev/null
  wait $WHISPER_PID $KOKORO_PID $SERVER_PID 2>/dev/null
  echo "Done. Docker containers left running."
}
trap cleanup EXIT

# --- Start Whisper STT ---

echo "Starting Whisper STT (port 8200)..."
whisper-server \
  --model "$WHISPER_MODEL" \
  --port 8200 \
  --threads 4 \
  --language en \
  2>&1 | sed 's/^/[whisper] /' &
WHISPER_PID=$!

# --- Start Kokoro TTS ---

echo "Starting Kokoro TTS (port 8201)..."
python3 "$NICOLE_DIR/nicole-macos/kokoro-server.py" \
  2>&1 | sed 's/^/[kokoro] /' &
KOKORO_PID=$!

# --- Start Nicole server ---

echo "Starting Nicole server (port 3000)..."
cd "$NICOLE_DIR"
npm run dev 2>&1 | sed 's/^/[nicole] /' &
SERVER_PID=$!

# --- Wait for everything to be ready ---

sleep 3
echo ""
echo "========================================="
echo "  Nicole is running"
echo "========================================="
echo "  Server   → http://localhost:3000"
echo "  Whisper  → http://localhost:8200"
echo "  Kokoro   → http://localhost:8201"
echo "  Postgres → localhost:5432"
echo "  SearXNG  → http://localhost:8888"
echo "========================================="
echo ""
echo "Press Ctrl+C to stop."
echo ""

wait
