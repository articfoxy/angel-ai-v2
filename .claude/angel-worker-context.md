# Angel Worker — Shared Project Context

> This file is read by the Angel AI worker before each task, and updated after each task.
> It provides continuity between tasks so the worker knows what's been done.

## Current State
- Project: Angel AI v2 — real-time AI companion via AirPods
- All features listed in CEO.md are implemented and deployed
- Server: Railway (production), Mobile: EAS OTA updates
- Latest: Claude Opus brain for Code mode, multi-project worker dispatch

## Recent Work
- Built 4 Angel modes: Translation, Intelligence, Hybrid, Code
- Code mode uses Claude Opus 4.6 as the AI brain
- Worker agent dispatches tasks to Claude Code on dev machines
- Perplexity AI integrated for web search
- Memory system with pgvector, 6-layer architecture
- TTS via Cartesia with queue stacking and speed control
- Worker stdin pipe test passed (2026-04-16)

## Active Decisions
- Always use `language=multi` for Deepgram (never specific locales)
- Audio settings apply on next session (iOS limitation)
- BYOK keys take priority over server env vars
- One active session at a time per user

## Important: When you complete a task
Update this file with what you did so the next task has context.
