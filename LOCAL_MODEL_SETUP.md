# Nicole Local Chat Setup

This setup keeps Nicole's state and orchestration on Banjo while moving chat
generation to a local Ollama model running on your Mac.

## Architecture

- `Banjo`
  - Nicole backend
  - Postgres memory and history
  - source library and uploads
  - tools and orchestration
- `Your Mac`
  - Ollama
  - `qwen3.5:9b`
  - hidden screen-awareness for the native app

## Banjo Environment

Add these environment variables on Banjo:

```env
CHAT_PROVIDER=ollama
OLLAMA_BASE_URL=http://YOUR_MAC_LAN_IP:11434
OLLAMA_CHAT_MODEL=qwen3.5:9b
OLLAMA_KEEP_ALIVE=30m
CHAT_FALLBACK_PROVIDER=cencori
```

Recommended while migrating:

```env
CHAT_MODEL=qwen3.5:9b
EMBED_MODEL=text-embedding-004
```

Notes:

- `CHAT_PROVIDER=ollama` makes Banjo send Nicole chat requests to your Mac.
- `OLLAMA_BASE_URL` should point at the Mac running Ollama, not Banjo.
- `CHAT_FALLBACK_PROVIDER=cencori` keeps Nicole alive if your Mac is asleep or
  Ollama is unavailable.
- Embeddings still use the existing provider path for now.

## Mac Setup

Run Ollama on your Mac and pull the model:

```bash
ollama pull qwen3.5:9b
```

Then make sure Ollama is reachable from Banjo on your local network. If Banjo
cannot reach your Mac yet, fix that before switching Nicole over.

## First Migration Pass

1. Pull the updated Nicole code onto Banjo.
2. Set the environment variables above.
3. Restart Nicole on Banjo.
4. Keep the Mac awake and Ollama running.
5. Send a normal Nicole message and confirm Banjo streams through the local
   model.

## Current Behavior

- Chat can run through Ollama on your Mac.
- Streaming is supported.
- Banjo still owns all shared history, memory, tools, and sources.
- If configured, Cencori can remain as fallback.
- Embeddings have not moved local yet.
