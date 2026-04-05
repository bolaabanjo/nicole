#!/bin/bash
# Start the local Whisper server for Nicole's voice input.
# This runs whisper.cpp's server with the large-v3-turbo model on port 8200.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL_PATH="$SCRIPT_DIR/../models/ggml-large-v3-turbo.bin"

if [ ! -f "$MODEL_PATH" ]; then
  echo "Model not found at $MODEL_PATH"
  echo "Download it with:"
  echo "  curl -L -o models/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
  exit 1
fi

echo "Starting Whisper server (large-v3-turbo) on port 8200..."
exec whisper-server \
  --model "$MODEL_PATH" \
  --port 8200 \
  --threads 4 \
  --language en
