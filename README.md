# Nicole

A fully local AI companion that runs entirely on one Mac. No cloud dependencies, no API keys, no data leaving your machine.

Nicole is a personal AI assistant with voice, vision, memory, web search, calendar, email, and proactive awareness — built as a native macOS app backed by a Next.js server and local LLMs.

## What She Can Do

- **Talk** — always-listening wake word ("Hey Nicole"), streaming TTS, barge-in interruption, progressive transcription
- **See** — screen capture and analysis via local multimodal model
- **Remember** — semantic memory that grows over time, conversation summaries, daily notes
- **Search** — live web search via SearXNG (Bing, Brave, DuckDuckGo), with relevance scoring and auto-enrichment
- **Research** — deep multi-source research with synthesis
- **Manage** — Google Calendar (read/write), Zoho Mail (search/send), reminders, notes
- **Nudge** — proactive heartbeat system checks calendar, reminders, screen time, and time of day without being asked
- **Think** — deterministic intent classifier routes every message to the right tools automatically, no LLM meta-decisions

## Architecture

```
┌─────────────────────────────────────────────┐
│              One Mac (M4 Pro)               │
│                                             │
│  Nicole.app (Swift)     ← UI, voice, screen │
│  Next.js server         ← brain, memory     │
│  Ollama (Qwen 3.5 9B)  ← local LLM         │
│  Whisper (large-v3-turbo) ← local STT       │
│  Kokoro (af_nicole)     ← local TTS         │
│  PostgreSQL + pgvector  ← database (Docker) │
│  SearXNG                ← web search (Docker)│
│  nomic-embed-text       ← embeddings        │
│                                             │
│  Everything is localhost. Zero network hops. │
└─────────────────────────────────────────────┘
```

| Component | Port |
|-----------|------|
| Nicole server (Next.js) | 3000 |
| Whisper STT | 8200 |
| Kokoro TTS | 8201 |
| PostgreSQL | 5432 |
| SearXNG | 8888 |
| Ollama | 11434 |

## Workspace

Nicole has her own home directory at `~/.nicole/` — inspired by the idea that she's a machine-level agent, not a codebase-level tool.

```
~/.nicole/
├── soul.md              # personality (single source of truth)
├── identity.md          # name, capabilities, infrastructure
├── user.md              # everything about the user
├── tools.md             # tool registry
├── config.md            # server URLs, model preferences
├── context.md           # current state, active work
├── memory/
│   ├── index.md
│   └── YYYY-MM-DD.md    # daily context notes
└── skills/
    ├── voice/
    ├── vision/
    ├── research/
    ├── email/
    ├── calendar/
    ├── study/
    └── heartbeat/
```

Her personality is an editable markdown file. Change `soul.md`, restart the server, and she's different.

## Voice

Nicole speaks and listens. Fully local, no cloud STT/TTS.

- **Wake word**: "Hey Nicole" via Whisper with VAD + anti-false-trigger tuning
- **Acknowledgment**: dynamic phrases when summoned ("Yes, Roy?", "What's on your mind?", etc.)
- **Noise filtering**: energy thresholds and minimum speech duration filter out clicks, taps, and ambient noise
- **Barge-in**: interrupt Nicole while she's speaking — she stops and listens
- **Progressive transcription**: Whisper transcribes audio every 2s while you speak, so response is near-instant when you stop
- **Status phrases**: "Let me look that up" spoken while tools execute, filling dead air
- **Full tools**: voice mode has the same capabilities as text — web search, calendar, reminders, memory, everything
- **Streaming TTS**: sentence-by-sentence playback with prefetching — Nicole speaks while still generating

## Intent Classifier

Instead of asking the LLM "should I use a tool?", Nicole classifies every message with deterministic pattern matching and routes to the appropriate tools automatically. The model only does what it's good at — generating language.

```
User message
    ↓
classifyIntent()              ← instant regex, zero LLM calls
    ↓
┌──────────────────────────────────────┐
│ casual          → no tools, no memory │
│ factual_question → web_search always  │
│ source_question  → source_search      │
│ personal_question → calendar/remind   │
│ action_request   → direct routing     │
│ workspace_question → workspace tools  │
│ ambiguous        → attach memory      │
└──────────────────────────────────────┘
    ↓
Build prompt with results → LLM generates language only
```

## Tools (25 ready)

`tool_registry_list`, `memory_search`, `memory_store`, `source_search`, `source_list`, `source_get`, `web_search`, `web_open`, `deep_research`, `note_create`, `note_update`, `calendar_read`, `calendar_create_event`, `reminder_create`, `email_search`, `email_send`, `terminal_run`, `git_status`, `workspace_read`, `workspace_write`, `workspace_list`, `workspace_append_daily`, `vision_capture`, `heartbeat_check`, `plugin_discover`

## Heartbeat

Nicole checks in without being asked. Every 5 minutes she monitors:

- **Calendar** — upcoming meetings within 30 minutes
- **Reminders** — due or overdue items
- **Screen time** — prolonged single-app usage
- **Time awareness** — late night detection

An LLM decision layer filters noise — she only nudges when something is genuinely worth saying. Rate limited to 4 nudges/hour with quiet hours (23:30–07:00).

## Access

- **Mac app** — native Swift app in `/Applications/Nicole.app`
- **Web** — `http://localhost:3000` or local network IP from any device
- **Phone** — PWA via browser, add to home screen
- **iOS app** — basic chat with trusted device pairing

## Setup

Prerequisites: macOS with Apple Silicon, Docker, Ollama, Node.js 20+.

```bash
# Start infrastructure
docker compose up -d          # PostgreSQL + SearXNG
ollama pull qwen3.5:9b        # Chat model
ollama pull nomic-embed-text  # Embeddings
ollama pull qwen3-vl:8b       # Vision model (optional)

# Start services
./start-nicole.sh             # Whisper, Kokoro, Next.js server

# Or auto-start on login
cp com.nicole.startup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nicole.startup.plist
```

## Built by

[Bola Banjo](https://github.com/bolaabanjo) — Founder & CEO at [FohnAI](https://fohnai.com)
