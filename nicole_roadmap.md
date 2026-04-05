# Nicole — The Full Roadmap

This is a lifelong project. No rush. Each phase builds on the last.

---

## Phase 0 — Foundation ✅ COMPLETE

Text-based study partner with memory, web search, and deep research.

- Chat API with streaming responses (Next.js)
- Nicole's personality system prompt (identity, humor, brevity, emotional awareness)
- AI routing: Ollama (local) with Cencori fallback
- PostgreSQL + pgvector for all storage
- SearXNG for web search
- Ingestion pipeline: PDF, URL, Markdown/notes with semantic chunking
- Drizzle ORM schema: sources, chunks, memories, chat messages, summaries, tool invocations, integrations, contacts, calendar events, reminders, notes

---

## Phase 1 — Smarter Brain ✅ COMPLETE

| Capability | Status |
|-----------|--------|
| Semantic memory retrieval (vector search, not top-30 dump) | ✅ Done |
| Memory dedup + updates (AI-powered merge/ignore/insert) | ✅ Done |
| Streaming responses (word-by-word via ReadableStream) | ✅ Done |
| Tool use / function calling (19 tools ready, full planning loop) | ✅ Done |
| Context-aware source retrieval (vector search on chunks) | ✅ Done |
| Conversation summarization (auto-compress old conversations) | ✅ Done |

### Tools ready (19):
`tool_registry_list`, `memory_search`, `memory_store`, `source_search`, `source_list`, `source_get`, `web_search`, `web_open`, `deep_research`, `note_create`, `note_update`, `calendar_read`, `calendar_create_event`, `reminder_create`, `email_search`, `email_send`, `terminal_run`, `git_status`

### Integrations working:
- Google Calendar (OAuth, read/write events)
- Zoho Mail (OAuth, search/send)

---

## Phase 2 — Voice ✅ COMPLETE

Nicole speaks and listens. Fully local, no cloud STT/TTS.

| Capability | Status | Tech |
|-----------|--------|------|
| Speech-to-text | ✅ Done | Whisper (whisper.cpp, large-v3-turbo, port 8200) |
| Text-to-speech | ✅ Done | Kokoro ONNX (af_nicole voice, 1.2x speed, port 8201), AVSpeechSynthesizer fallback |
| Wake word | ✅ Done | "Hey Nicole" via Whisper with VAD + anti-false-trigger tuning |
| Always-listening mode | ✅ Done | SharedAudioEngine with AudioConsumer protocol, single mic session |
| Conversation mode | ✅ Done | Auto-listen after Nicole speaks, 30-min timeout, exit phrases ("bye", "nevermind", etc.) |
| Streaming TTS | ✅ Done | Sentence-by-sentence queue with prefetching — Nicole speaks while still generating |
| Voice endpoint | ✅ Done | `/api/nicole/voice` — compact prompt (~800 tokens), no tool planning, think:false, 1.2s to first token |
| Voice mode UI | ✅ Done | Animated glowing orb, reacts to mic/speaker levels, state-driven (idle/listening/thinking/speaking) |

### Voice latency (before → after):
| Metric | Old (via /stream) | New (via /voice) |
|--------|-------------------|------------------|
| Time to first token | 11.9s | 1.2s |
| Time to Nicole's first words | ~13s | ~2.5s |

---

## Phase 2.5 — Native Mac App ✅ COMPLETE

Nicole is a native macOS citizen. Built in Swift, runs as standalone app.

### UI Modes
| Mode | Status | Description |
|------|--------|-------------|
| Expanded | ✅ Done | Full window with chat history, message bubbles, composer, file attachments |
| Compact | ✅ Done | Overlay panel (Ctrl+N), floats above all apps including fullscreen, slides in/out |
| Voice | ✅ Done | Full-screen dark UI with animated orb, toggle from navbar or auto-activated by wake word |

### Workspace Context Capture
| Capability | Status | API |
|-----------|--------|-----|
| Active app | ✅ Done | NSWorkspace |
| Window title | ✅ Done | CGWindowListCopyWindowInfo |
| Selected text | ✅ Done | Accessibility API |
| Clipboard | ✅ Done | NSPasteboard |
| File path | ✅ Done | NSWorkspace + AppleScript |
| Screen OCR | ✅ Done | ScreenCaptureKit + VNRecognizeTextRequest (.accurate) |
| Context caching | ✅ Done | FastWorkspaceProbe + WorkspaceSnapshotStore |

### Native Features
| Feature | Status |
|---------|--------|
| Global hotkey (Ctrl+N) | ✅ Done |
| Standalone .app in /Applications | ✅ Done |
| File drag-and-drop to composer | ✅ Done |
| Settings panel (server URL, voice toggles) | ✅ Done |

---

## Infrastructure ✅ COMPLETE

Everything runs on one M4 Pro Mac. No external dependencies.

```
┌─────────────────────────────────────────────┐
│              This Mac (M4 Pro)              │
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

| Component | Port | Auto-start |
|-----------|------|------------|
| Nicole server (Next.js) | 3000 | ✅ via launchd |
| Whisper STT | 8200 | ✅ via launchd |
| Kokoro TTS | 8201 | ✅ via launchd |
| PostgreSQL | 5432 | ✅ via Docker |
| SearXNG | 8888 | ✅ via Docker |
| Ollama | 11434 | ✅ (system service) |

`start-nicole.sh` — single script launches Docker, Whisper, Kokoro, and the Nicole server.
`com.nicole.startup.plist` — launchd agent runs it all on login.

---

## Phone Access ✅

- Web PWA (Next.js UI) — accessible from phone via local network or Tailscale
- iOS app (nicole-ios) — basic chat with trusted device pairing

---

## Phase 3.5 — Workspace (~/.nicole/) ✅ COMPLETE

Nicole has her own home directory on the Mac. Inspired by OpenClaw's architecture.

```
~/.nicole/
├── soul.md              # personality — who Nicole is (single source of truth)
├── identity.md          # name, capabilities, infrastructure
├── user.md              # everything about Roy
├── tools.md             # tool registry (ready + planned)
├── config.md            # server URLs, model preferences, paths
├── context.md           # current state, active work
├── memory/
│   ├── index.md         # long-term memory index
│   └── YYYY-MM-DD.md    # daily context notes
└── skills/
    ├── voice/SKILL.md
    ├── vision/SKILL.md
    ├── research/SKILL.md
    ├── email/SKILL.md
    ├── calendar/SKILL.md
    └── study/SKILL.md
```

| Capability | Status |
|-----------|--------|
| Soul file (personality as editable markdown) | ✅ Done |
| Identity file (who she is, what she runs on) | ✅ Done |
| User file (everything about Roy) | ✅ Done |
| Tools registry (all 47 tools documented) | ✅ Done |
| Config file (server URLs, model prefs, paths) | ✅ Done |
| Context file (current state, active work) | ✅ Done |
| Memory directory (index + daily notes) | ✅ Done |
| Skill files (self-describing per skill) | ✅ Done |
| Server reads soul.md on startup | ✅ Done |
| Nicole can write to her own workspace files | ✅ Done (workspace_read/write/list/append_daily tools) |
| Skill auto-discovery from skills/ directory | ✅ Done (injected into system prompt) |

---

## Phase 3.7 — Heartbeat (Proactive Mode) ✅ COMPLETE

Nicole checks in without being asked. She monitors calendar, reminders, screen time, and time of day.

| Capability | Status |
|-----------|--------|
| Heartbeat engine (server-side check runner) | ✅ Done |
| Calendar check (upcoming meetings within 30 min) | ✅ Done |
| Reminders check (due/overdue reminders) | ✅ Done |
| Screen time tracking (prolonged single-app usage) | ✅ Done |
| Time awareness (late night detection) | ✅ Done |
| LLM decision layer ("should I tell Roy?") | ✅ Done |
| macOS notification delivery | ✅ Done |
| Voice nudge (speaks if voice mode active) | ✅ Done |
| Rate limiting (cooldown, max nudges/hour) | ✅ Done |
| Quiet hours (23:30–07:00, urgent overrides) | ✅ Done |
| Heartbeat state persistence | ✅ Done |
| Config file (~/.nicole/heartbeat.md) | ✅ Done |
| Heartbeat API endpoint (/api/nicole/heartbeat) | ✅ Done |
| Mac app polling (NicoleHeartbeatController) | ✅ Done |
| Email check | Disabled (ready, needs testing) |
| Health metrics (Apple Watch / HealthKit) | Not started (Phase 5) |
| Weather alerts | Not started |
| Morning briefing | Not started |

---

## What's Next

---

## Phase 3 — Eyes (Vision) ✅ COMPLETE

Nicole can see what's on screen via a local multimodal model.

| Capability | Tech | Status |
|-----------|------|--------|
| Screen capture | ScreenCaptureKit → JPEG base64 | ✅ Done |
| Vision model | qwen3-vl:8b via Ollama (6.1GB) | ✅ Done |
| Vision endpoint | `/api/nicole/vision` — streaming, think:false | ✅ Done |
| Voice → vision routing | Trigger phrases ("look at my screen", etc.) | ✅ Done |
| Screen OCR (workspace context) | VNRecognizeTextRequest (.accurate) | ✅ Done (Phase 2.5) |
| Camera input | AVFoundation → multimodal LLM | Not started |
| Document scanning | Camera → OCR → ingestion pipeline | Not started |
| Continuous vision | Periodic screenshots → summarize | Not started |

**Note:** M4 Pro 24GB runs chat (qwen3.5:9b) or vision (qwen3-vl:8b) one at a time — Ollama swaps automatically.

---

## Phase 4 — Integrations (Nicole Connects to Your World)

| Integration | Status | Notes |
|------------|--------|-------|
| Google Calendar | ✅ Done | OAuth, read/write events |
| Zoho Mail | ✅ Done | OAuth, search/send |
| Notes | ✅ Done | Local storage, CRUD via tools |
| Reminders | ✅ Done | Local storage, due dates |
| GitHub | Planned | PRs, issues, commits |
| WhatsApp | Planned | Baileys (local WhatsApp Web API) |
| Slack | Planned | Bot API |
| Apple Reminders | Planned | AppleScript bridge |
| Spotify / Apple Music | Planned | REST API |
| Contacts (unified) | Planned | Multi-device sync, dedup by phone number |
| Calling (WhatsApp-first) | Planned | Deep links, VoIP later |

### Plugin System (planned)
Each integration becomes a plugin Nicole discovers automatically. Drop a file, she reads it and starts using it.

---

## Phase 4.5 — Agentic Computer Use

Nicole controls your Mac — opens apps, clicks, types, browses.

| Capability | Status |
|-----------|--------|
| Terminal commands (safe subset) | ✅ Done |
| Git status/diff | ✅ Done |
| Full screen control (Accessibility API) | Not started |
| Multi-step action planning | Not started |
| Task approval system (risk levels) | Framework ready (DB schema exists) |

---

## Phase 5 — Hardware (Nicole in the Physical World)

| System | Status |
|--------|--------|
| Apple Watch (HealthKit) | Not started |
| Smart home (Home Assistant) | Not started |
| Car (OBD-II) | Not started |
| AirPods (voice relay) | Not started |

---

## Phase 6 — Autonomy (Nicole Acts Without Being Asked)

| Capability | Status |
|-----------|--------|
| Proactive alerts | Not started |
| Routine automation (morning briefing) | Not started |
| Pattern recognition | Not started |
| Predictive actions | Not started |
| Background monitoring | Not started |

---

## Phase 7 — Own Your Models (The Endgame)

| Step | Status |
|------|--------|
| Export conversation data | Not started (10K+ exchanges needed) |
| Fine-tune chat model on your data | Not started |
| Specialist models (code, health, home, vision) | Not started |
| Continuous learning loop | Not started |

---

## Cross-Cutting Capabilities

| Capability | Status |
|-----------|--------|
| Device trust / auth | ✅ Done (iOS pairing, token validation) |
| Voice biometrics | Not started |
| Emotional awareness (typing/voice patterns) | Not started |
| Multi-language (auto-detect, code-switching) | Not started |
| Backup (pg_dump, Time Machine) | Not started (manual) |
| File/photo organization | Not started |
| Multi-user (speaker ID, per-person permissions) | Not started |

---

## Suggested Build Order (Updated)

```
✅ DONE     Phase 0: Foundation
✅ DONE     Phase 1: Smarter brain (memory, tools, streaming, search)
✅ DONE     Phase 2: Voice (Whisper + Kokoro + wake word + streaming TTS)
✅ DONE     Phase 2.5: Native Mac app (Swift) + screen awareness
✅ DONE     Infrastructure: Everything on one Mac, auto-start on login
 │
 ├── ✅ DONE  Phase 3: Vision (local multimodal model)
 │
 ├── ✅ DONE  Phase 3.5: Workspace (~/.nicole/) — soul, identity, tools, skills, memory as files
 │
 ├── ✅ DONE  Phase 3.7: Heartbeat — proactive nudges (calendar, reminders, screen time)
 │
 ├── NEXT   Phase 4: More integrations (GitHub, WhatsApp, Spotify)
 │            + Plugin system (skill auto-discovery from ~/.nicole/skills/)
 │
 ├── LATER  Phase 4.5: Agentic computer use + approval system
 │
 ├── LATER  Phase 5: Hardware (watch, home, car)
 │
 ├── LATER  Phase 6: Autonomy (proactive, predictive)
 │
 └── LATER  Phase 7: Own models, self-improving loop
```
