cd nicole-macos && ./build.sh

# Nicole → Jarvis — The Full Roadmap

This is a lifelong project. No rush. Each phase builds on the last.

---

## Where You Are Now (Phase 0 ✅)

Text-based study partner with memory, web search, and deep research.

```
You ──(text)──→ Nicole ──(API)──→ Gemini 2.5 Flash
                  │
          ┌───────┴───────┐
        Memory       Web Search
       (Postgres)    (SearXNG)
```

---

## Nicole's Model Architecture (Local-First)

Everything runs on your own hardware. No cloud dependency. The key insight: **Nicole is the router, not the model.** She sits on top of multiple specialist brains and picks the right one.

```
                  You (voice / text / image)
                           │
                           ▼
                ┌──────────────────────┐
                │    Nicole (Router)    │
                │   Decides which brain │
                │   handles this task   │
                └──────────┬───────────┘
                           │
         ┌─────────────────┼──────────────────┐
         ▼                 ▼                  ▼
   ┌───────────┐   ┌──────────────┐   ┌────────────┐
   │  Chat 14B │   │  Vision 7-13B│   │  Whisper   │
   │  (Ollama) │   │  (LLaVA/etc) │   │  (speech)  │
   │           │   │              │   │            │
   │ casual    │   │ see screens  │   │ voice →    │
   │ talk,     │   │ read docs    │   │ text       │
   │ quick Q&A │   │ camera input │   │            │
   └───────────┘   └──────────────┘   └────────────┘
         ALL RUNNING LOCALLY ON YOUR HARDWARE
```

### Which model handles what

| Task | Model | Size | Runs On |
|------|-------|------|---------|
| Casual conversation, personality | Fine-tuned chat model | 14B | Mac / home server |
| Quick tool calls (calendar, lights) | Same chat model | 14B | Mac / home server |
| Complex reasoning (rare, hard tasks) | Larger local model or API fallback | 32-70B or API | Server / cloud |
| Vision (screen, camera, documents) | LLaVA / Qwen-VL / local multimodal | 7-13B | Mac / home server |
| Speech-to-text | Whisper | ~1.5B | Mac (runs fast on M4) |
| Text-to-speech | Piper / Coqui TTS | Small | Mac / Pi |
| Embeddings | Local embedding model | ~400M | Mac |
| Code generation | Code-specialist model | 14-32B | Server |
| Health / sensor analysis | Fine-tuned specialist | 7-14B | Server |

> [!TIP]
> Your M4 Pro with 24GB can comfortably run **one 14B model + Whisper + TTS + embeddings simultaneously.** For running multiple large models or a 70B, you'd eventually want a dedicated home server (Mac Studio with 192GB, or a used workstation with GPUs).

### The fallback hierarchy

```
1. Try local model first (free, fast, private)     ← 80% of requests
2. If task is too complex → try larger local model  ← 15% of requests
3. If still not enough → API fallback (Cencori)     ← 5% of requests
```

This means Nicole works **fully offline** for most things, and only reaches out to the cloud when she truly needs to.

---

## Phase 1 — Smarter Brain (Software Only)

Make Nicole genuinely intelligent with what you already have.

| Capability | What It Does | Effort |
|-----------|-------------|--------|
| **Semantic memory retrieval** | Embed memories, pull relevant ones per conversation topic instead of top-30 | Medium |
| **Memory dedup + updates** | "I moved to Lagos" replaces "lives in London" | Medium |
| **Streaming responses** | Nicole responds word-by-word, not all at once | Low |
| **Tool use / function calling** | Nicole can call functions: set reminders, check calendar, run code | Medium |
| **Context-aware source retrieval** | Vector search chunks relevant to current question, not random 50 | Medium |
| **Conversation summarization** | Compress old conversations into summaries to extend effective memory | Medium |

> [!IMPORTANT]
> This phase is the highest ROI. Everything after depends on Nicole having a solid brain.

---

## Phase 2 — Voice (Hands-Free Nicole)

Nicole speaks and listens. This changes everything about how you interact.

| Capability | Tech Options | Notes |
|-----------|-------------|-------|
| **Speech-to-text** | Whisper (local on M4 Pro), Deepgram API, or Web Speech API | Whisper runs great on Apple Silicon |
| **Text-to-speech** | ElevenLabs, Coqui TTS (local), or Apple's AVSpeechSynthesizer | Pick a voice that feels right for Nicole |
| **Wake word** | Porcupine (Picovoice), or custom keyword detection | "Hey Nicole" |
| **Always-listening mode** | Background process on Mac/phone, or dedicated Raspberry Pi | Pi is better for "room presence" |
| **Conversation mode** | Interrupt handling, turn-taking, silence detection | Makes it feel natural, not walkie-talkie |

**Starter path:** Web Speech API (browser-native, zero cost) → upgrade to Whisper + ElevenLabs when you want higher quality.

---

## Phase 2.5 — Native Mac App (Swift)

Nicole becomes a native macOS citizen. Replaces the web UI entirely. Separate repo: `nicole-macos`.

### Core Experience

```
⌘+Shift+N → Nicole slides in from the right

┌──────────────────────────────────────────────────────┐
│  You're reading a PDF / browsing / coding            │
│                                                      │
│                        ┌─────────────────────────┐   │
│                        │  nicole                  │   │
│                        │                         │   │
│                        │  [sees your screen]     │   │
│                        │  [knows the app, file,  │   │
│                        │   page you're on]       │   │
│                        │                         │   │
│                        │  > explain this to me   │   │
│                        │                         │   │
│                        │  Nicole responds with   │   │
│                        │  full context...        │   │
│                        │                         │   │
│                        │  [___________________]  │   │
│                        └─────────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘

⌘+Shift+N again → Nicole slides away
```

### Two modes

| Mode | When | UI |
|------|------|----|
| **Compact** | Quick questions, commands | Narrow panel, slides in from right |
| **Expanded** | Deep study, research, writing | Full panel with chat history, sources, study modes |

Both share the same conversation, same memory, same brain. Toggle between them.

### Computer use (screen awareness)

| Capability | macOS API | What Nicole gets |
|-----------|-----------|------------------|
| **Screenshot** | ScreenCaptureKit | What's visually on screen |
| **Active app** | NSWorkspace | "Safari", "Preview", "VS Code" |
| **Window title** | CGWindowListCopyWindowInfo | "arxiv paper on transformers", "router.ts" |
| **Selected text** | Accessibility API | Text you've highlighted |
| **Clipboard** | NSPasteboard | What you just copied |
| **File path** | NSWorkspace + AppleScript | The exact file/URL open |

Nicole doesn't just see pixels — she knows **what you're doing** and **what you're looking at.**

### Native macOS features

| Feature | API |
|---------|-----|
| Global hotkey (⌘+Shift+N) | `CGEvent` tap |
| Overlay panel | `NSPanel` (floats above other apps) |
| Launch at login | `SMAppService` |
| Notifications | `UNUserNotificationCenter` |
| File drag-and-drop | `NSDraggingDestination` |
| Voice input (later) | `AVAudioEngine` + Whisper |
| Spotlight-style search | Custom `NSPanel` |

### Architecture

```
┌──────────────────────────────┐
│    nicole-macos (Swift)       │
│    The client / interface     │
│                              │
│  Screen capture              │
│  Global hotkey               │
│  UI (SwiftUI)                │
│  Voice I/O (later)           │
└──────────────┬───────────────┘
               │ HTTP / WebSocket
               ▼
┌──────────────────────────────┐
│    nicole (Next.js)           │
│    The brain / backend        │
│                              │
│  /api/nicole (chat)          │
│  /api/nicole/context (screen)│
│  Memory, search, tools       │
│  Model router                │
└──────────────────────────────┘
```

The Swift app is a dedicated client. The Next.js server remains the brain. This way the phone PWA, the Mac app, and any future clients all share the same Nicole.

> [!IMPORTANT]
> This replaces the web UI for daily use on Mac. The web UI stays as a fallback and for phone access.

---

## Phase 3 — Eyes (Vision)

Nicole can see what you see or what you show her.

| Capability | Tech Options | Notes |
|-----------|-------------|-------|
| **Screen sharing** | ScreenCaptureKit (via Swift app) or screenshot API | "Nicole, what's wrong with this code?" |
| **Camera input** | AVFoundation (Mac) / phone camera → multimodal LLM | "What's this?" while pointing at something |
| **Document scanning** | Camera → OCR → ingestion pipeline | Point at a whiteboard, Nicole captures it |
| **Continuous vision** | Periodic screenshots/frames → summarize what's happening | Like Jarvis monitoring displays |

**Starter path:** Computer use via the Swift app → send screenshots to local multimodal model.

---

## Phase 4 — Integrations (Nicole Connects to Your World)

This is where it starts feeling like Jarvis.

### Personal Tools
| Integration | How | Protocol |
|------------|-----|----------|
| **Calendar** | Google Calendar API or CalDAV | REST API |
| **Email** | Gmail API or IMAP | REST/IMAP |
| **Notes** | Apple Notes (AppleScript), Notion API, or Nicole's own notes | Various |
| **Tasks/Reminders** | Apple Reminders (AppleScript), Todoist API | Various |
| **Browser** | Chrome extension that sends current tab/page to Nicole | WebSocket |
| **Music** | Spotify API, Apple Music (Shortcuts) | REST API |
| **Finance** | Plaid API or manual CSV import | REST API |

### Developer Tools
| Integration | How |
|------------|-----|
| **GitHub** | GitHub API — PRs, issues, commits |
| **Terminal** | Nicole runs commands for you (sandboxed) |
| **Code review** | Git diff → Nicole reviews changes |

### Communication
| Integration | How |
|------------|-----|
| **WhatsApp** | Baileys (open-source WhatsApp Web API, runs locally) |
| **Slack** | Slack Bot API |
| **SMS** | Twilio |

### Contacts (Unified Contact Book)

Nicole doesn't rely on any single phone's contacts. She builds her own unified contact book by syncing from all your devices.

```sql
CREATE TABLE contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT NOT NULL,
  nicknames       TEXT[],           -- ['Cass', 'Cassandra', 'Cassie']
  phones          JSONB,            -- [{number: '+234...', label: 'personal'}, ...]
  emails          JSONB,
  notes           TEXT,             -- "college friend, lives in Lagos"
  source_devices  TEXT[],           -- which devices this contact was synced from
  last_contacted  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);
```

**Multi-device sync:** Nicole pulls contacts from all your phones and merges them. Deduplication by phone number — if two contacts on different devices share the same number, they're the same person. Different names get stored as nicknames.

```
Phone 1 (iPhone):    "Cassandra B" → +234-xxx-1111
Phone 2 (work):      "Cass"        → +234-xxx-1111
Phone 3 (old):       "Cass B."     → +234-xxx-1111, +234-xxx-2222

Nicole merges → one contact:
  Name: Cassandra B
  Nicknames: [Cass, Cass B.]
  Phones: [+234-xxx-1111 (primary), +234-xxx-2222 (alt)]
  Source devices: [iPhone, work phone, old phone]
```

**Disambiguation — "Hey Nicole, call Cass":**

| Scenario | Nicole's response |
|----------|------------------|
| One Cass | Calls her directly |
| Two people named Cass | "Cass Baker or Cass Williams?" |
| One Cass, two numbers | Uses the one you called last, or asks |
| No match | "I don't have anyone called Cass." |
| Learns over time | "When he says Cass, he always means Cass Baker" → stored in memory |

### Calling (WhatsApp-First)

Since you primarily use WhatsApp calls:

| Method | How it works |
|--------|-------------|
| **WhatsApp call (phone)** | Nicole sends deep link `whatsapp://call?phone=+234xxx` → WhatsApp opens on your phone, call starts |
| **WhatsApp call (Mac)** | Nicole triggers WhatsApp Desktop → call starts on Mac, AirPods pick up |
| **Regular call (fallback)** | `tel://` URL scheme via Siri Shortcut on iPhone |
| **VoIP (future)** | Nicole gets her own SIP line via Twilio/Asterisk — she can make calls independently |

**Nicole as a WhatsApp contact:** Baileys also lets Nicole receive messages via WhatsApp. You can text her like she's a person in your contacts:

```
You (WhatsApp): "what time is my meeting tomorrow"
Nicole (WhatsApp): "10am with David, Google Meet link is..."
```

No PWA or Swift app needed when you're on the go — just text Nicole on WhatsApp.

**During calls (VoIP, future):**

| Capability | How |
|-----------|-----|
| Real-time transcription | Whisper processes call audio live |
| Silent assistant | "Nicole, what did she say about the deadline?" |
| Post-call summary | "Here's a summary of your call with Cass" |
| Action items | Nicole extracts todos from the conversation |

**Architecture:** Build a **tool/plugin system** in Nicole. Each integration is a tool she can call. The model decides when to use which tool based on your request.

```
"What's on my calendar today?"
     │
     ▼
Nicole detects intent → calls calendar_tool
     │
     ▼
Returns structured data → Nicole formats natural response
```

---

## Phase 4.5 — Agentic Computer Use (Nicole Takes Actions)

Nicole doesn't just watch your screen — she controls it. She can open apps, click buttons, type text, browse the web, and complete multi-step tasks on your behalf. Even when you're not home.

### How Nicole controls your Mac

| Action | macOS API | Example |
|--------|-----------|--------|
| **Open apps** | `NSWorkspace.shared.open()` | Opens Mail, Safari, Finder |
| **Click** | `CGEvent` (synthetic mouse) | Clicks buttons, links, menus |
| **Type** | `CGEvent` (synthetic keyboard) | Fills in forms, writes emails |
| **Read UI elements** | Accessibility API (`AXUIElement`) | Finds buttons, text fields, menus by name |
| **Scroll** | `CGEvent` scroll events | Scrolls through pages, lists |
| **Run scripts** | `NSAppleScript` / `Process` | AppleScript, shell commands |
| **Read screen** | ScreenCaptureKit | Visual fallback when accessibility data isn't enough |

> [!TIP]
> The **Accessibility API** is the key advantage on macOS. Instead of just screenshotting and guessing where to click (like browser-based computer use), Nicole reads the actual UI tree — every button, label, text field, menu item. Faster, more reliable, no vision model needed for most actions.

### The action loop

```
You: "Send an email to X about the meeting next week"
       │
       ▼
Nicole plans: [open Mail, compose, write, review, send]
       │
       ▼
  For each step:
    1. Take action (open app, click, type)
    2. Read screen (Accessibility API + screenshot)
    3. Decide next action
    4. Repeat until done or needs your input
       │
       ▼
  "Draft ready. Want me to send it?"
```

### Task approval system

Nicole doesn't act without permission when it matters. Every action has a risk level:

| Risk Level | Behavior | Examples |
|-----------|----------|----------|
| **Low** | Nicole just does it | Check calendar, look something up, open an app |
| **Medium** | Does it, notifies you after | Add calendar event, save a file, create a reminder |
| **High** | Drafts and waits for your approval | Send email, post on social media, book a flight |
| **Critical** | Refuses without explicit confirmation | Financial transactions, delete files, change passwords |

You review and approve from anywhere — your phone, your laptop, your watch.

### Remote task execution

```
You (phone, at a conference in Dubai)
       │
       │  Tailscale (encrypted)
       ▼
Nicole (your Mac at home, always on)
       │
       ├── Receives task
       ├── Executes steps on your Mac
       ├── Sends draft/preview to your phone for review
       ├── You approve/edit/reject
       └── Nicole completes the action
       │
       ▼
  "Done. Email sent to X. ✓"
```

### Database: pending tasks queue

```sql
CREATE TABLE pending_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  description TEXT NOT NULL,          -- "Send email to X about meeting"
  type        TEXT NOT NULL,          -- 'email', 'calendar', 'browse', 'file'
  risk_level  TEXT NOT NULL,          -- 'low', 'medium', 'high', 'critical'
  payload     JSONB,                  -- {draft, to, subject, attachments}
  status      TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'completed', 'failed'
  result      TEXT,                   -- outcome or error message
  created_at  TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
```

This same approval pattern scales to everything — booking flights, adjusting your thermostat, posting on social media, making purchases. One system, escalating trust.

---

## Phase 5 — Hardware (Nicole in the Physical World)

### Wearables
| Device | Integration Path |
|--------|-----------------|
| **Apple Watch** | HealthKit API → vitals → Nicole tracks trends ("your resting heart rate is up this week") |
| **Smart Glasses** | Camera feed + bone conduction audio. Wait for better hardware (Meta/Apple) or build with existing frames |
| **AirPods** | Already works with voice — Siri Shortcut that routes to Nicole |

### Home
| System | Integration Path |
|--------|-----------------|
| **Lights** | HomeKit / Philips Hue API / Home Assistant |
| **Thermostat** | HomeKit / Nest API / Home Assistant |
| **Locks** | HomeKit / August API |
| **Speakers** | AirPlay / Sonos API — Nicole's voice throughout the house |
| **Cameras** | HomeKit / RTSP streams → vision pipeline |
| **Custom sensors** | Raspberry Pi + sensors → MQTT → Nicole |

> [!TIP]
> **Home Assistant** is the single best investment here. It unifies hundreds of smart home devices under one local API. Nicole talks to Home Assistant, Home Assistant talks to everything else.

### Car
| Capability | Path |
|-----------|------|
| **OBD-II data** | Bluetooth OBD2 adapter → phone → Nicole (fuel, diagnostics, trips) |
| **Location** | Phone GPS → Nicole knows where you are |
| **CarPlay** | Siri Shortcut → Nicole (voice interaction while driving) |
| **Tesla/EV API** | If applicable — start/stop charging, climate, lock/unlock |

---

## Infrastructure — Remote Access (Nicole From Anywhere)

You're in Lagos, Tokyo, or a café in London. Nicole is on your home server. How do you reach her?

### Option A: Tailscale (Recommended)

Tailscale creates a private encrypted network between all your devices. Your phone, laptop, and home server are all on the same virtual network — no matter where you are in the world.

```
┌─────────────────────────────────────┐
│         Tailscale Network           │
│         (encrypted mesh)            │
│                                     │
│  📱 Phone ──────── 🏠 Home Server  │
│  💻 Laptop ─────── 🏠 Home Server  │
│  ⌚ Watch (via phone) ── 🏠 Home   │
│                                     │
│  All devices see each other as if   │
│  they're on the same local network  │
└─────────────────────────────────────┘
```

- **Free tier** covers all personal devices
- **Zero config** — install on each device, it just works
- **No port forwarding**, no exposed servers, no attack surface
- Access Nicole at the same local address from anywhere: `http://100.x.x.x:3000`

### Option B: Cloudflare Tunnel

Your architecture doc already mentions this. Exposes Nicole at `nicole.bolabanjo.xyz` through an encrypted tunnel. No open ports.

### Option C: WireGuard VPN (DIY)

Same idea as Tailscale but self-hosted. More control, more setup.

### What needs to stay home

| Component | Why It Can't Travel |
|-----------|--------------------|
| Postgres (memories, chat history) | Your data lives here |
| Local models (Ollama) | Too big to run on phone |
| Home Assistant | Controls your physical home |
| SearXNG | Web search proxy |

### What travels with you

| Component | How |
|-----------|-----|
| Chat UI | Browser on any device → connects home via Tailscale |
| Voice | Phone mic → Whisper on home server → response → phone speaker |
| Location/context | Phone sends GPS/context to home server |
| Watch vitals | Watch → phone → home server |

> [!IMPORTANT]
> You'll eventually want a **dedicated always-on home server** instead of relying on your MacBook. A Mac Mini or Mac Studio is ideal — low power, quiet, Apple Silicon for running models. Your HP EliteBook "Banjo" can serve this role for now.

---

## Phase 6 — Autonomy (Nicole Acts Without Being Asked)

This is peak Jarvis.

| Capability | Example |
|-----------|---------|
| **Proactive alerts** | "Your heart rate has been elevated for 3 days. You might be getting sick." |
| **Routine automation** | Morning briefing: weather, calendar, unread messages, tasks |
| **Pattern recognition** | "You always order food on Fridays around 7pm. Want me to order your usual?" |
| **Predictive actions** | "Your meeting with X is in 30 minutes. Based on traffic, leave in 10." |
| **Background monitoring** | Track stock prices, package deliveries, flight delays |
| **Self-improvement** | Nicole identifies gaps in her own knowledge and suggests improvements |

---

## Phase 7 — Own Your Models (The Endgame)

Not one model. Multiple specialists, all local, all yours.

| Model | Purpose | Training Data | Size |
|-------|---------|---------------|------|
| **Nicole-Chat** | Personality, conversation, daily interaction | Your chat_messages table | 14B |
| **Nicole-Code** | Code review, generation, debugging | Your repos + code conversations | 14-32B |
| **Nicole-Health** | Vitals analysis, health trends | Your HealthKit data + health conversations | 7B |
| **Nicole-Home** | Smart home control, routines | Your Home Assistant logs + commands | 7B |
| **Nicole-Vision** | Seeing, reading, understanding images | Your screenshots + camera interactions | 7-13B |

| Step | When |
|------|------|
| Export conversation data from Postgres | When you have 10K+ exchanges |
| Fine-tune first chat model on your data | Tools: Unsloth, Axolotl, or MLX |
| Run on dedicated home server | Mac Mini/Studio with 64-192GB RAM |
| Add specialist models over time | As you accumulate domain-specific data |
| Continuous learning loop | New conversations → periodic re-training |
| Nicole trains herself | She identifies when she's wrong and flags for retraining |
---

## Cross-Cutting Capabilities (Woven Into Every Phase)

These aren't standalone phases — they evolve alongside everything else.

---

### Security & Authentication

Nicole will eventually control your email, your home, your finances. She needs to know it's **you** giving the orders.

| Layer | How | When |
|-------|-----|------|
| **Device trust** | Only recognized devices (Mac, phone, watch) can talk to Nicole | Phase 1+ |
| **Voice biometrics** | Nicole recognizes your voice vs. someone else's | Phase 2+ |
| **Biometric confirmation** | Face ID / Touch ID on phone for high-risk approvals | Phase 4.5+ |
| **Session tokens** | API requests require auth tokens, rotated periodically | Phase 1+ |
| **Action signing** | Critical actions require a signed confirmation from a trusted device | Phase 4.5+ |
| **Audit log** | Every action Nicole takes is logged with who authorized it | Phase 4+ |

---

### Emotional Awareness

Nicole reads the room. She adapts to how you're feeling — not because you tell her, but because she notices.

| Signal | Source | What Nicole does |
|--------|--------|-----------------|
| **Typing patterns** | Chat (short replies, all caps, long pauses) | Adjusts tone — calmer when you're stressed, more direct when you're focused |
| **Voice tone** | Whisper analysis (pitch, speed, energy) | "You sound tired. Want me to keep this brief?" |
| **Heart rate / HRV** | Apple Watch via HealthKit | Detects stress, fatigue, excitement |
| **Time of day** | System clock | Different energy at 2am vs. 10am |
| **Context** | Calendar + recent activity | Knows if you just got out of a 3-hour meeting |

Nicole doesn't announce this. She just *responds differently.* Like a friend who can tell when you're not in the mood.

---

### Multi-Language

Nicole speaks whatever language fits the moment.

| Capability | How |
|-----------|-----|
| **Auto-detect language** | If you type in Yoruba, she responds in Yoruba |
| **Code-switching** | Mix languages naturally — she follows your lead |
| **Translation** | "Nicole, say that in French" |
| **Voice in any language** | Multilingual TTS models (Coqui, Bark) |

---

### Backup & Disaster Recovery

Nicole's brain is priceless. If your Mac dies, she shouldn't die with it.

| What | How | Frequency |
|------|-----|-----------|
| **Postgres** | `pg_dump` → encrypted backup to external drive or NAS | Daily |
| **Model weights** | Stored on external SSD, versioned | After each fine-tune |
| **Memories + chat history** | Part of Postgres backup | Daily |
| **Config & code** | Git (already done — `nicole` repo) | Every change |
| **Full system image** | Time Machine or restic to NAS | Weekly |

Recovery: spin up Postgres on new hardware, restore dump, clone repo, download models. Nicole is back in an hour.

---

### File & Photo Organization

Nicole manages your digital life, not just conversations.

| Capability | How |
|-----------|-----|
| **"Find that screenshot"** | Embed file metadata + OCR text, vector search | 
| **Auto-organize Downloads** | Watch folder → classify → move to right location |
| **Photo tagging** | Vision model scans photos, tags people/places/events |
| **Document search** | "Nicole, find my tax return from 2024" → searches local files |
| **Smart folders** | Nicole creates and maintains organized folder structures |

---

### Plugin System (Nicole Teaches Herself)

Instead of coding every integration manually, Nicole learns new tools through plugins.

```
plugins/
├── calendar.ts        — Google Calendar integration
├── email.ts           — Gmail / Mail.app integration
├── spotify.ts         — Music control
├── home-assistant.ts  — Smart home
├── github.ts          — Code repos
└── custom/
    └── your-plugin.ts — Anything you build
```

Each plugin exposes:
- **Name & description** (so Nicole knows when to use it)
- **Functions** (actions Nicole can call)
- **Permissions** (what risk level each action has)

Nicole discovers plugins automatically. You drop a new file in the plugins folder, she reads the description and starts using it. Later, she could even write her own plugins.

---

### Multi-User (Nicole Knows Who She's Talking To)

Nicole is primarily yours. But she should recognize when someone else is interacting with her.

| Feature | How |
|---------|-----|
| **Voice identification** | Speaker diarization — Nicole knows who's speaking |
| **Device-based identity** | Your phone = you, your girlfriend's phone = her |
| **Per-person memories** | Nicole remembers things about each person separately |
| **Per-person permissions** | You: full access. Partner: conversation + home control. Guest: conversation only |
| **Personality adaptation** | Nicole can adjust her tone per person — more casual with you, more polite with family |
| **Privacy boundaries** | Nicole never shares your private memories/data with other users |

```sql
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  role        TEXT DEFAULT 'guest',   -- 'owner', 'partner', 'family', 'guest'
  voice_id    TEXT,                    -- voice print for speaker recognition
  device_ids  TEXT[],                  -- trusted device identifiers
  permissions JSONB,                   -- {computer_use: false, home: true, ...}
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Memories are now per-user
ALTER TABLE memories ADD COLUMN user_id UUID REFERENCES users(id);
-- Chat messages track who said them
ALTER TABLE chat_messages ADD COLUMN user_id UUID REFERENCES users(id);
```

> [!NOTE]
> Nicole's loyalty is to you. She's helpful to others, but she's *your* Jarvis. Other users get a friendly, capable assistant — you get the full experience.

---

## Suggested Build Order

```
NOW          Phase 1: Smarter memory + streaming + tool use
 │             + Security foundations (device trust, session tokens)
 │             + Backup strategy
 │
 ├── 3-6mo   Phase 2: Voice (Whisper + TTS)
 │             + Emotional awareness (voice tone)
 │             + Multi-language (auto-detect)
 │
 ├── 4-8mo   Phase 2.5: Native Mac app (Swift) + screen awareness
 │
 ├── 6-12mo  Phase 3: Vision (multimodal, camera)
 │             + File/photo organization
 │
 ├── 1-2yr   Phase 4: Integrations (calendar, email, GitHub, music)
 │             + Plugin system
 │             + Multi-user basics
 │
 ├── 1-2yr   Phase 4.5: Agentic computer use + approval system
 │             + Biometric auth for high-risk actions
 │
 ├── 2-3yr   Phase 5: Hardware (watch, home, car)
 │             + Emotional awareness (vitals, HRV)
 │             + Voice biometrics (speaker ID)
 │
 ├── 3-5yr   Phase 6: Autonomy (proactive, predictive)
 │             + Nicole writes her own plugins
 │
 └── 5yr+    Phase 7: Own models, self-improving loop
```

> [!NOTE]
> These timelines are for a hobby project — weekends and evenings. Each phase could be compressed significantly with focused effort. The key is that each phase makes Nicole meaningfully more useful, so you get value at every step.
