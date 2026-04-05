#!/usr/bin/env python3
"""
Local Kokoro TTS server for Nicole.
Runs on port 8201, accepts POST /tts with JSON {"text": "..."} and returns WAV audio.
"""

import io
import json
import struct
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

from kokoro_onnx import Kokoro

MODEL_DIR = "../models"
HOST = "127.0.0.1"
PORT = 8201

# Nicole's voice — pick one that sounds right
# Options include: af_heart, af_bella, af_sarah, af_nicole, af_sky, am_adam, am_michael, etc.
VOICE = "af_nicole"
SPEED = 1.0

kokoro: Kokoro = None


def pcm_to_wav(samples, sample_rate: int) -> bytes:
    """Convert float32 PCM samples to WAV bytes."""
    import numpy as np
    int_samples = (samples * 32767).astype(np.int16)
    buf = io.BytesIO()
    num_samples = len(int_samples)
    data_size = num_samples * 2
    # WAV header
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))       # chunk size
    buf.write(struct.pack("<H", 1))        # PCM
    buf.write(struct.pack("<H", 1))        # mono
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", sample_rate * 2))
    buf.write(struct.pack("<H", 2))        # block align
    buf.write(struct.pack("<H", 16))       # bits per sample
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    buf.write(int_samples.tobytes())
    return buf.getvalue()


class TTSHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/tts":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)

            try:
                data = json.loads(body)
                text = data.get("text", "").strip()
                voice = data.get("voice", VOICE)
                speed = data.get("speed", SPEED)
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON")
                return

            if not text:
                self.send_error(400, "No text provided")
                return

            try:
                samples, sample_rate = kokoro.create(text, voice=voice, speed=speed)
                wav_bytes = pcm_to_wav(samples, sample_rate)

                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav_bytes)))
                self.end_headers()
                self.wfile.write(wav_bytes)
            except Exception as e:
                self.send_error(500, str(e))
                return

        elif self.path == "/voices":
            voices = kokoro.get_voices()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"voices": voices}).encode())

        else:
            self.send_error(404)

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        elif self.path == "/voices":
            voices = kokoro.get_voices()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"voices": voices}).encode())
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        # Quieter logging
        pass


def main():
    global kokoro

    model_path = f"{MODEL_DIR}/kokoro-v1.0.onnx"
    voices_path = f"{MODEL_DIR}/voices-v1.0.bin"

    print(f"Loading Kokoro model from {model_path}...")
    kokoro = Kokoro(model_path, voices_path)
    print(f"Kokoro loaded. Default voice: {VOICE}")

    # Warm up with a short synthesis
    kokoro.create("Ready.", voice=VOICE, speed=SPEED)
    print(f"Kokoro TTS server running on http://{HOST}:{PORT}")

    server = HTTPServer((HOST, PORT), TTSHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Kokoro TTS server.")
        server.server_close()


if __name__ == "__main__":
    main()
