#!/bin/bash
# Angel AI — Claude Code Worker Setup
# Run this once on any machine to connect it to Angel AI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/articfoxy/angel-ai-v2/main/packages/worker/setup.sh | bash -s -- --token YOUR_AUTH_TOKEN
#
# Or manually:
#   bash setup.sh --token YOUR_AUTH_TOKEN --name "My MacBook"

set -e

ANGEL_SERVER="https://server-production-ff34.up.railway.app"
MACHINE_NAME=""
AUTH_TOKEN=""
INSTALL_DIR="$HOME/.angel-worker"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --token) AUTH_TOKEN="$2"; shift 2 ;;
    --name) MACHINE_NAME="$2"; shift 2 ;;
    --server) ANGEL_SERVER="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$AUTH_TOKEN" ]; then
  echo "❌ Error: --token is required"
  echo ""
  echo "Get your token from Angel AI app → Settings → Developer → Auth Token"
  echo ""
  echo "Usage: bash setup.sh --token YOUR_AUTH_TOKEN"
  exit 1
fi

# Default machine name to hostname
if [ -z "$MACHINE_NAME" ]; then
  MACHINE_NAME=$(hostname -s 2>/dev/null || hostname)
fi

echo "🤖 Angel AI — Claude Code Worker Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Machine: $MACHINE_NAME"
echo "Server:  $ANGEL_SERVER"
echo ""

# Create install directory
mkdir -p "$INSTALL_DIR"

# Write the worker script (self-contained, no dependencies beyond Node)
cat > "$INSTALL_DIR/worker.mjs" << 'WORKER_EOF'
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { hostname } from 'os';
import { readFileSync } from 'fs';

// Load config
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const { serverUrl, authToken, machineName } = config;

const WS_URL = `${serverUrl.replace(/^http/, 'ws')}/ws/worker?token=${encodeURIComponent(authToken)}&name=${encodeURIComponent(machineName)}`;

let ws = null;
let reconnectAttempts = 0;

function connect() {
  console.log(`[Angel Worker] Connecting to ${serverUrl} as "${machineName}"...`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    reconnectAttempts = 0;
    console.log('[Angel Worker] ✅ Connected! Waiting for tasks...');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'registered') {
        console.log(`[Angel Worker] Registered as ${msg.workerId}`);
      } else if (msg.type === 'task') {
        handleTask(msg.taskId, msg.prompt, msg.context);
      }
    } catch {}
  });

  ws.on('close', () => {
    console.log('[Angel Worker] Disconnected');
    reconnect();
  });

  ws.on('error', (err) => {
    console.error('[Angel Worker] Error:', err.message);
  });
}

function reconnect() {
  if (reconnectAttempts >= 20) { console.error('Max reconnects. Exiting.'); process.exit(1); }
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  console.log(`[Angel Worker] Reconnecting in ${delay/1000}s...`);
  setTimeout(connect, delay);
}

function handleTask(taskId, prompt, context) {
  console.log(`\n[Angel Worker] 📋 Task: ${prompt.slice(0, 100)}`);
  const fullPrompt = context ? `Context:\n${context}\n\nTask: ${prompt}` : prompt;

  const claude = spawn('claude', ['--print', '--message', fullPrompt], {
    cwd: process.env.HOME, shell: true, env: { ...process.env },
  });

  let result = '';
  let chunk = '';

  claude.stdout.on('data', (d) => {
    const t = d.toString(); result += t; chunk += t;
    if (chunk.length >= 500) { send({ type: 'chunk', taskId, text: chunk }); chunk = ''; }
  });

  claude.on('close', (code) => {
    if (chunk) send({ type: 'chunk', taskId, text: chunk });
    if (code === 0) { send({ type: 'complete', taskId, result }); console.log(`✅ Done (${result.length} chars)`); }
    else { send({ type: 'error', taskId, error: result || `Exit code ${code}` }); console.log(`❌ Failed`); }
  });

  claude.on('error', (err) => {
    send({ type: 'error', taskId, error: `Spawn failed: ${err.message}` });
  });
}

function send(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

connect();
process.on('SIGINT', () => { console.log('\nShutting down...'); ws?.close(); process.exit(0); });
WORKER_EOF

# Write config
cat > "$INSTALL_DIR/config.json" << EOF
{
  "serverUrl": "$ANGEL_SERVER",
  "authToken": "$AUTH_TOKEN",
  "machineName": "$MACHINE_NAME"
}
EOF

# Write package.json for ws dependency
cat > "$INSTALL_DIR/package.json" << 'EOF'
{ "name": "angel-worker", "type": "module", "dependencies": { "ws": "^8.14.0" } }
EOF

# Install dependencies
echo "📦 Installing dependencies..."
cd "$INSTALL_DIR" && npm install --silent 2>/dev/null

# Create a simple start script
cat > "$INSTALL_DIR/start.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")" && node worker.mjs
EOF
chmod +x "$INSTALL_DIR/start.sh"

echo ""
echo "✅ Angel Worker installed to $INSTALL_DIR"
echo ""
echo "To start manually:"
echo "  $INSTALL_DIR/start.sh"
echo ""
echo "To auto-start with Claude Code, add to ~/.claude/settings.json:"
echo '  "hooks": {'
echo '    "SessionStart": [{'
echo '      "matcher": "startup",'
echo '      "hooks": [{'
echo '        "type": "command",'
echo "        \"command\": \"$INSTALL_DIR/start.sh &\","
echo '        "timeout": 5'
echo '      }]'
echo '    }]'
echo '  }'
echo ""

# Ask to start now
read -p "Start worker now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "🚀 Starting Angel Worker..."
  node "$INSTALL_DIR/worker.mjs"
fi
