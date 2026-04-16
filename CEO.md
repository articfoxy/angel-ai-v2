# Angel AI v2 — CEO Memory File

> Last updated: 2026-04-17 | 118 commits | Owner: ArticFoxy

## What is Angel AI?

A personal AI companion that streams audio via AirPods for real-time transcription and AI-powered insights. Think: an AI whispering in your ear during any conversation — translating languages, explaining jargon, coaching your communication, taking meeting notes, or dispatching coding tasks to your dev machines.

## Product Vision

**"An AI that listens to your life and makes you superhuman."**

Angel AI sits in your AirPods during every conversation. It hears everything, remembers everything, and whispers the right insight at the right moment. Over time, it builds a persistent memory of your world — people, preferences, decisions, context — becoming more useful with every session.

## Architecture

```
┌──────────────┐     socket.io      ┌──────────────────┐      WebSocket      ┌─────────────┐
│  iOS App     │ ◄──────────────── │  Server (Railway) │ ──────────────────► │ Claude Code  │
│  (Expo/RN)   │     audio/events   │  Express+Socket   │    worker agents    │ (Dev machines)│
└──────┬───────┘                    └────────┬─────────┘                     └─────────────┘
       │                                     │
       │ AirPods mic                         ├── Deepgram (STT)
       │ TTS playback                        ├── OpenAI Realtime API (AI brain)
       │                                     ├── Cartesia (TTS voice)
       │                                     ├── Perplexity (search)
       │                                     └── PostgreSQL + pgvector (memory)
```

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Mobile | Expo (React Native) | iOS app, AirPods audio |
| Server | Express + Socket.io | Real-time relay, orchestration |
| STT | Deepgram Nova-3 | Speech-to-text, multilingual, diarization |
| AI Brain (default) | OpenAI Realtime API | Whisper generation for Translation/Intelligence/Hybrid |
| AI Brain (Code) | Claude Opus 4.6 API | Primary brain for Code mode, falls back to OpenAI if no Anthropic key |
| TTS | Cartesia Sonic | Text-to-speech via AirPods |
| Search | Perplexity Sonar | Real-time web search with citations |
| Memory | PostgreSQL + pgvector | 6-layer memory with vector similarity |
| Code Bridge | Custom WebSocket hub | Dispatch tasks to Claude Code instances |
| Hosting | Railway (server), EAS (mobile OTA) | Production deployment |

## The 4 Modes

| Mode | What it does | Trigger speed | Use case |
|------|-------------|---------------|----------|
| **Translation** | Smart-translates foreign language speech | Every 1 line (80ms endpointing) | Business meetings with non-English speakers |
| **Intelligence** | Jargon, meeting notes, coaching, fact-checking, sales, learning | Every 3 lines (150ms endpointing) | Any professional conversation |
| **Hybrid** | Translation + intelligence combined | Every 2 lines | Mixed-language meetings with insights |
| **Code** | Coding assistant + Claude Code dispatch | Every 2 lines | Technical discussions, pair programming. **Uses Claude Opus 4.6 as brain** (not OpenAI) |

## Memory System (6 Layers)

```
Layer 6: Core Memory     — Always in prompt (~500 tokens). User profile, preferences, key people, goals.
Layer 5: Reflections      — Higher-order insights from patterns. "User prefers value framing over discounts."
Layer 4: Relationships    — Temporal graph edges. "User --[works_with]--> Sarah (since Jan)"
Layer 3: Entities         — People, orgs, places, topics with aliases.
Layer 2: Memories         — Extracted facts with embeddings. Vector search via pgvector.
Layer 1: Episodes         — Raw transcript segments. Non-lossy record.
```

**Retrieval**: 5-factor composite scoring (relevance 35%, recency 25%, importance 20%, connectivity 10%, access frequency 10%). Top 10 memories injected into AI prompt. Refreshed every 10 transcript lines.

**Extraction**: Post-session, GPT-4o-mini extracts facts, entities, relationships. Core memory self-updates. Reflections generated when cumulative importance exceeds threshold.

## Claude Code Bridge

Angel's server acts as a WebSocket task relay hub. Claude Code worker agents connect from developer machines, receive coding tasks via voice commands, execute them, and stream results back as whisper cards.

```
Voice: "Angel, build a login component"
  → AI calls code_task function
  → Server dispatches to connected worker
  → Worker runs: claude --print --message "..."
  → Results stream back → whisper cards show progress
```

**Multi-project dispatch**: Worker registers all git repos on the machine. Tasks auto-route to the correct project based on conversation context (mentions "angel-ai" → runs in angel-ai-v2 dir). User can also explicitly say "in my angel project, build X".

**Setup**: Run one command on any machine → worker installs to ~/.angel-worker/ → auto-connects to server. Add `--project /path` to set default project. Worker auto-scans for all registered projects.

## Key Features

### Audio Pipeline
- AirPods mic → 16kHz PCM → Socket.io binary → Deepgram Nova-3 → diarized transcript
- Speaker identification: Owner vs Person A/B/C (voiceprint-based)
- Multilingual: `language=multi` transcribes any language
- Echo gating: mutes transcript feed during TTS playback to prevent AI hearing itself

### TTS Playback
- Cartesia WebSocket streaming → base64 PCM chunks → react-native-audio-api AudioContext
- Queue stacking: whispers play in order, not cancel each other
- Speed control: 1x/1.5x/2x/3x via PCM sample decimation (client-side)
- Buffer underrun handling: onEnded only triggers completion after allChunksSent flag

### Text Messaging
- Type directly to Angel during active sessions
- Fed as [Owner] transcript → forceRespond() → guaranteed response
- `/` prefix for system commands (modify AI behavior live)

### Search
- Voice: "Angel, search for X" → Perplexity Sonar API → cited answer
- Fallback to DuckDuckGo/Brave if Perplexity unavailable

### Test Conversations
- Nuclear Fusion (jargon test) — 3 scientists discussing tokamak physics
- Chinese Business Meeting (translation test) — Owner speaks English, others speak Mandarin with word-by-word streaming

## Navigation (5 Tabs)

| Tab | Screen | Purpose |
|-----|--------|---------|
| Start | StartScreen | Transcript + mode cards + angel button + text input |
| History | HistoryScreen | Past session cards with debrief navigation |
| Memory | MemoryScreen | 4-tab browser: Core, Entities, Facts, Insights |
| Skills | SkillsScreen | Skills marketplace (future) |
| Settings | SettingsScreen | Voice, audio, API keys, Claude Code bridge, account |

## Infrastructure

| Service | Details |
|---------|---------|
| Railway project | `1d5d3951-4b9f-43d0-943d-4db97afbfa76` |
| Railway service | `be552356-ec5f-491a-b83c-dead9edf7d2e` |
| Server URL | `https://server-production-ff34.up.railway.app` |
| EAS project | `e09202a5-3fdc-4ee6-a646-485b4e99e1c5` |
| Bundle ID | `com.angelai.app` |
| Build number | 33 (runtime 2.0.0) |
| Railway API token | Project token (mutations only, no `me` query) |

## Env Vars (Railway)

`OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `PERPLEXITY_API_KEY`, `JWT_SECRET`, `DATABASE_URL`, `NODE_ENV`, `PORT`

## Deployment Flow

1. Code changes → `git push origin main`
2. Server: Railway GraphQL `serviceInstanceDeployV2` with full commit SHA
3. Mobile: `npx eas-cli update --branch production` (OTA, no native build needed unless native modules change)
4. Native build: `npx eas build --platform ios --profile production` (TestFlight)

## Standing Rules

- Always audit code TWICE before deploying
- Always bump buildNumber before TestFlight
- Deploy server via Railway GraphQL API with FULL commit SHA
- Do NOT delete features without asking the user first
- Use `language=multi` for Deepgram (never specific locales)
- Session cleanup: 4-layer (disconnect, session:start, POST /sessions, server startup)

## Audit History

| Audit | Issues Found | Issues Fixed |
|-------|-------------|-------------|
| #1 | 20 | 20 |
| #2 | 8 | 8 |
| #3 | 9 | 9 |
| #4 | 20 | 20 |
| Memory scan | 3 | 3 |
| **Total** | **60+** | **60+** |

## What's Next

- [ ] Skills marketplace (create/share/import AI skills)
- [ ] Scheduled tasks (daily summaries, reminders)
- [ ] Multi-user (shared sessions, team whispers)
- [ ] Web dashboard (view transcripts, manage memory)
- [ ] Advanced entity graph (relationship visualization)
- [ ] Offline mode (local STT + cached whispers)
