# Angel AI v2 — Project Instructions

## CEO Memory File
Always read `CEO.md` at the project root at the start of any session. It contains the full product overview, architecture, features, infrastructure, and standing rules.

**When you add or change a feature, update CEO.md to reflect the change.** Keep it accurate as the single source of truth.

## Standing Rules
- Always audit code TWICE before deploying
- Always bump buildNumber in app.json before a TestFlight build
- Deploy server via Railway GraphQL API with FULL commit SHA (not short)
- Do NOT delete features without asking the user first
- Use `language=multi` for Deepgram transcription (never specific locales)
- Run `npx tsc --noEmit` for both mobile and server before committing
- NVM path: `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ | tail -1)/bin:$PATH"`

## Deployment
- **Server**: Railway GraphQL mutation `serviceInstanceDeployV2` with commit SHA
- **Mobile OTA**: `npx eas-cli update --branch production --message "..." --non-interactive`
- **Native build** (only when native modules change): `npx eas build --platform ios --profile production`

## Key Paths
- Server: `packages/server/src/`
- Mobile: `apps/mobile/src/`
- Worker agent: `packages/worker/`
- Schema: `packages/server/prisma/schema.prisma`
