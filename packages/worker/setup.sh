#!/bin/bash
# Angel AI — Claude Code Worker Setup
# Run this once on any machine to connect it to Angel AI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/articfoxy/angel-ai-v2/main/packages/worker/setup.sh | bash -s -- --token YOUR_TOKEN
#
# Or manually:
#   bash setup.sh --token YOUR_AUTH_TOKEN --name "My MacBook"

set -e

ANGEL_SERVER="https://server-production-ff34.up.railway.app"
MACHINE_NAME=""
AUTH_TOKEN=""
PROJECT_DIR=""
INSTALL_DIR="$HOME/.angel-worker"

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case $1 in
    --token) AUTH_TOKEN="$2"; shift 2 ;;
    --name) MACHINE_NAME="$2"; shift 2 ;;
    --server) ANGEL_SERVER="$2"; shift 2 ;;
    --project) PROJECT_DIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$AUTH_TOKEN" ]; then
  echo "❌ Error: --token is required"
  echo ""
  echo "Get your token from Angel AI app → Settings → Claude Code Bridge → Copy Command"
  echo ""
  echo "Usage: bash setup.sh --token YOUR_AUTH_TOKEN"
  exit 1
fi

# ── Detect Node.js (check nvm, homebrew, system) ──
detect_node() {
  # Already on PATH?
  if command -v node &>/dev/null; then return 0; fi
  # nvm?
  if [ -d "$HOME/.nvm/versions/node" ]; then
    local latest=$(ls "$HOME/.nvm/versions/node/" | sort -V | tail -1)
    if [ -n "$latest" ]; then
      export PATH="$HOME/.nvm/versions/node/$latest/bin:$PATH"
      return 0
    fi
  fi
  # fnm?
  if [ -d "$HOME/.fnm" ]; then
    export PATH="$HOME/.fnm:$PATH"
    eval "$(fnm env 2>/dev/null)" 2>/dev/null
    if command -v node &>/dev/null; then return 0; fi
  fi
  return 1
}

if ! detect_node; then
  echo "❌ Node.js not found. Install it from https://nodejs.org or via nvm."
  exit 1
fi

NODE_VERSION=$(node -v 2>/dev/null)
NPM_VERSION=$(npm -v 2>/dev/null)
echo "🤖 Angel AI — Claude Code Worker Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Default machine name
if [ -z "$MACHINE_NAME" ]; then
  MACHINE_NAME=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "Unknown")
fi

echo "Machine:  $MACHINE_NAME"
echo "Server:   $ANGEL_SERVER"
echo "Node:     $NODE_VERSION (npm $NPM_VERSION)"

# Check for Claude CLI
if command -v claude &>/dev/null; then
  echo "Claude:   ✅ Found"
else
  echo "Claude:   ⚠️  Not found (install: npm install -g @anthropic-ai/claude-code)"
fi
echo ""

# ── Create install directory ──
mkdir -p "$INSTALL_DIR"

# ── Write worker script ──
cat > "$INSTALL_DIR/worker.mjs" << 'WORKER_EOF'
import WebSocket from 'ws';
import { spawn, execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const { serverUrl, authToken, machineName, projectDir } = config;
const CWD = projectDir && existsSync(projectDir) ? projectDir : homedir();
const WS_URL = `${serverUrl.replace(/^http/, 'ws')}/ws/worker?token=${encodeURIComponent(authToken)}&name=${encodeURIComponent(machineName)}`;

// ── Find Claude CLI binary ──
function findClaude() {
  // 1. Check PATH
  try { const p = execSync('which claude 2>/dev/null', { encoding: 'utf8' }).trim(); if (p) return p; } catch {}

  // 2. Claude Desktop app (macOS)
  const vmDir = join(homedir(), 'Library/Application Support/Claude/claude-code-vm');
  if (existsSync(vmDir)) {
    try {
      const versions = readdirSync(vmDir).sort().reverse();
      for (const v of versions) {
        const bin = join(vmDir, v, 'claude');
        if (existsSync(bin)) return bin;
      }
    } catch {}
  }

  // 3. Common global install paths
  const candidates = [
    join(homedir(), '.npm-global/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) { if (existsSync(c)) return c; }

  // 4. nvm global
  try {
    const nvmDir = join(homedir(), '.nvm/versions/node');
    if (existsSync(nvmDir)) {
      const versions = readdirSync(nvmDir).sort().reverse();
      for (const v of versions) {
        const bin = join(nvmDir, v, 'bin/claude');
        if (existsSync(bin)) return bin;
      }
    }
  } catch {}

  return null;
}

const CLAUDE_BIN = findClaude();
if (CLAUDE_BIN) {
  console.log(`[Angel Worker] Claude CLI: ${CLAUDE_BIN}`);
} else {
  console.error('[Angel Worker] ⚠️  Claude CLI not found — tasks will fail until installed');
}

let ws = null, reconnectAttempts = 0;

function connect() {
  console.log(`[Angel Worker] Connecting to ${serverUrl} as "${machineName}"...`);
  ws = new WebSocket(WS_URL);
  ws.on('open', () => { reconnectAttempts = 0; console.log('[Angel Worker] ✅ Connected! Waiting for tasks...'); });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'registered') console.log(`[Angel Worker] Registered as ${msg.workerId}`);
      else if (msg.type === 'task') handleTask(msg.taskId, msg.prompt, msg.context);
    } catch {}
  });
  ws.on('close', () => { console.log('[Angel Worker] Disconnected'); reconnect(); });
  ws.on('error', (err) => console.error('[Angel Worker] Error:', err.message));
}

function reconnect() {
  if (reconnectAttempts >= 20) { console.error('Max reconnects reached. Exiting.'); process.exit(1); }
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  console.log(`[Angel Worker] Reconnecting in ${delay/1000}s...`);
  setTimeout(connect, delay);
}

function handleTask(taskId, prompt, context) {
  if (!CLAUDE_BIN) {
    send({ type: 'error', taskId, error: 'Claude CLI not found on this machine. Install Claude Code first.' });
    return;
  }
  console.log(`\n[Angel Worker] 📋 Task: ${prompt.slice(0, 120)}`);
  console.log(`[Angel Worker] CWD: ${CWD}, Model: opus`);
  const fullPrompt = context ? `Context:\n${context}\n\nTask: ${prompt}` : prompt;
  const claude = spawn(CLAUDE_BIN, ['--print', '--model', 'opus', '--message', fullPrompt], { cwd: CWD, env: { ...process.env } });
  let result = '', chunk = '';
  claude.stdout.on('data', (d) => { const t = d.toString(); result += t; chunk += t; if (chunk.length >= 500) { send({ type: 'chunk', taskId, text: chunk }); chunk = ''; } });
  claude.stderr.on('data', () => {}); // Suppress spinner output
  claude.on('close', (code) => {
    if (chunk) send({ type: 'chunk', taskId, text: chunk });
    if (code === 0) { send({ type: 'complete', taskId, result }); console.log(`✅ Done (${result.length} chars)`); }
    else { send({ type: 'error', taskId, error: result || `Claude exited with code ${code}` }); console.log('❌ Failed'); }
  });
  claude.on('error', (err) => send({ type: 'error', taskId, error: `Failed to start Claude: ${err.message}` }));
}

function send(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
connect();
process.on('SIGINT', () => { console.log('\nShutting down...'); ws?.close(); process.exit(0); });
WORKER_EOF

# ── Write config ──
cat > "$INSTALL_DIR/config.json" << EOF
{
  "serverUrl": "$ANGEL_SERVER",
  "authToken": "$AUTH_TOKEN",
  "machineName": "$MACHINE_NAME",
  "projectDir": "${PROJECT_DIR:-$HOME}"
}
EOF

# ── Write package.json ──
cat > "$INSTALL_DIR/package.json" << 'EOF'
{ "name": "angel-worker", "type": "module", "dependencies": { "ws": "^8.14.0" } }
EOF

# ── Install dependencies (with timeout and visible output) ──
echo "📦 Installing dependencies..."
cd "$INSTALL_DIR"

# Use timeout to prevent npm hanging forever (60s max)
if command -v timeout &>/dev/null; then
  timeout 60 npm install 2>&1 || {
    echo "⚠️  npm install timed out or failed. Trying with --prefer-offline..."
    timeout 30 npm install --prefer-offline 2>&1 || true
  }
else
  # macOS doesn't have timeout by default — use background + wait
  npm install 2>&1 &
  NPM_PID=$!
  SECONDS=0
  while kill -0 $NPM_PID 2>/dev/null; do
    if [ $SECONDS -ge 60 ]; then
      echo "⚠️  npm install taking too long, killing..."
      kill $NPM_PID 2>/dev/null
      wait $NPM_PID 2>/dev/null
      break
    fi
    sleep 1
  done
  wait $NPM_PID 2>/dev/null
fi

# Verify ws installed
if [ ! -f "$INSTALL_DIR/node_modules/ws/lib/websocket.js" ]; then
  echo "❌ Failed to install 'ws' package. Try manually:"
  echo "   cd $INSTALL_DIR && npm install"
  exit 1
fi

# ── Write start script (with nvm detection) ──
cat > "$INSTALL_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
# Angel AI Worker — Start Script
# Detects Node.js via nvm/fnm/system and starts the worker

# Find node
if ! command -v node &>/dev/null; then
  if [ -d "$HOME/.nvm/versions/node" ]; then
    LATEST=$(ls "$HOME/.nvm/versions/node/" | sort -V | tail -1)
    [ -n "$LATEST" ] && export PATH="$HOME/.nvm/versions/node/$LATEST/bin:$PATH"
  fi
fi

if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found"; exit 1
fi

cd "$(dirname "$0")" && exec node worker.mjs
STARTEOF
chmod +x "$INSTALL_DIR/start.sh"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Angel Worker installed to $INSTALL_DIR"
echo ""
echo "Start now:   $INSTALL_DIR/start.sh"
echo "Stop:        Ctrl+C"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Auto-start (only if running interactively, not piped)
if [ -t 0 ]; then
  read -p "🚀 Start worker now? (y/n) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    exec "$INSTALL_DIR/start.sh"
  fi
else
  # Piped from curl — start automatically
  echo "🚀 Starting Angel Worker..."
  exec "$INSTALL_DIR/start.sh"
fi
