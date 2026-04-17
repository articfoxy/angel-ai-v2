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

# ── Write worker script (synced with ~/.angel-worker/worker.mjs) ──
cat > "$INSTALL_DIR/worker.mjs" << 'WORKER_EOF'
import WebSocket from 'ws';
import { spawn, execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const { serverUrl, authToken, machineName, defaultProject, projects } = config;
const WS_URL = `${serverUrl.replace(/^http/, 'ws')}/ws/worker?token=${encodeURIComponent(authToken)}&name=${encodeURIComponent(machineName)}`;

const projectMap = {};
for (const p of (projects || [])) {
  if (existsSync(p.path)) { projectMap[p.name.toLowerCase()] = p.path; projectMap[p.path.split('/').pop().toLowerCase()] = p.path; }
}
const DEFAULT_CWD = defaultProject && existsSync(defaultProject) ? defaultProject : homedir();

function findClaude() {
  try { const p = execSync('which claude 2>/dev/null', { encoding: 'utf8' }).trim(); if (p) return p; } catch {}
  const codeDir = join(homedir(), 'Library/Application Support/Claude/claude-code');
  if (existsSync(codeDir)) { try { const vs = readdirSync(codeDir).sort().reverse(); for (const v of vs) { const b = join(codeDir, v, 'claude.app/Contents/MacOS/claude'); if (existsSync(b)) return b; } } catch {} }
  for (const c of [join(homedir(), '.npm-global/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']) { if (existsSync(c)) return c; }
  try { const nd = join(homedir(), '.nvm/versions/node'); if (existsSync(nd)) { const vs = readdirSync(nd).sort().reverse(); for (const v of vs) { const b = join(nd, v, 'bin/claude'); if (existsSync(b)) return b; } } } catch {}
  return null;
}

function detectProject(prompt, context) {
  const text = `${prompt} ${context || ''}`.toLowerCase();
  for (const [alias, path] of Object.entries(projectMap)) { if (text.includes(alias)) return path; }
  return DEFAULT_CWD;
}

const CLAUDE_BIN = findClaude();
console.log(`[Angel Worker] Claude: ${CLAUDE_BIN || 'NOT FOUND'}`);
console.log(`[Angel Worker] Projects: ${(projects || []).map(p => p.name).join(', ') || 'none'}`);
console.log(`[Angel Worker] Default: ${DEFAULT_CWD}`);

let ws = null, reconnectAttempts = 0, pingInterval = null;
function connect() {
  console.log(`[Angel Worker] Connecting to ${serverUrl} as "${machineName}"...`);
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    reconnectAttempts = 0; console.log('[Angel Worker] ✅ Connected!');
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) { try { ws.ping(); } catch {} send({ type: 'ping' }); } }, 25000);
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'registered') { console.log(`[Angel Worker] Registered as ${msg.workerId}`); send({ type: 'projects', projects: (projects || []).map(p => p.name) }); }
      else if (msg.type === 'task') handleTask(msg.taskId, msg.prompt, msg.context, msg.project);
      else if (msg.type === 'cancel') handleCancel(msg.taskId);
      else if (msg.type === 'pong') {}
    } catch {}
  });
  ws.on('pong', () => {});
  ws.on('close', (code, reason) => { if (pingInterval) { clearInterval(pingInterval); pingInterval = null; } console.log(`[Angel Worker] Disconnected (${code}${reason ? ': ' + reason : ''})`); reconnect(); });
  ws.on('error', (err) => console.error('[Angel Worker] Error:', err.message));
}
function reconnect() {
  reconnectAttempts++;
  // First 5 retries: 1s each (fast reconnect during deploy ~30-60s window). Then exp backoff capped at 30s. Never give up.
  const delay = reconnectAttempts <= 5 ? 1000 : Math.min(1000 * Math.pow(2, reconnectAttempts - 5), 30000);
  if (reconnectAttempts === 6) console.log('[Angel Worker] Server still down — switching to exponential backoff');
  setTimeout(connect, delay);
}

// Track active task so we can cancel it via SIGTERM/SIGKILL
let activeTask = null; // { taskId, process, cancelled }

function handleCancel(taskId) {
  if (activeTask && activeTask.taskId === taskId) {
    console.log(`[Angel Worker] 🛑 Cancelling task ${taskId}`);
    activeTask.cancelled = true;
    try {
      activeTask.process.kill('SIGTERM');
      setTimeout(() => { if (activeTask && activeTask.taskId === taskId) { try { activeTask.process.kill('SIGKILL'); } catch {} } }, 2000);
    } catch (e) { console.warn('[Angel Worker] kill failed:', e.message); }
  }
}

function handleTask(taskId, prompt, context, requestedProject) {
  if (!CLAUDE_BIN) { send({ type: 'error', taskId, error: 'Claude CLI not found' }); return; }
  let cwd = DEFAULT_CWD;
  if (requestedProject && projectMap[requestedProject.toLowerCase()]) cwd = projectMap[requestedProject.toLowerCase()];
  else cwd = detectProject(prompt, context);

  console.log(`\n[Angel Worker] 📋 Task: ${prompt.slice(0, 120)}`);
  console.log(`[Angel Worker] 📂 Project: ${cwd}`);

  const memoryFile = join(cwd, '.claude', 'angel-worker-context.md');
  let sharedMemory = '';
  try { if (existsSync(memoryFile)) sharedMemory = readFileSync(memoryFile, 'utf8'); } catch {}

  let fullPrompt = '';
  if (sharedMemory) fullPrompt += `## Shared Project Context:\n${sharedMemory}\n\n`;
  if (context) fullPrompt += `## Conversation Context:\n${context}\n\n`;
  fullPrompt += `## Task:\n${prompt}\n\nAfter completing the task, update .claude/angel-worker-context.md with a brief summary of what you did.`;

  // Spawn via login shell so Claude CLI inherits full user env (Keychain auth, PATH)
  // Critical when worker runs as LaunchAgent — minimal env breaks auth
  const shell = process.env.SHELL || '/bin/zsh';
  const claudeCmd = `"${CLAUDE_BIN}" -p --model opus --dangerously-skip-permissions`;
  const claude = spawn(shell, ['-lc', claudeCmd], { cwd, env: { ...process.env, HOME: process.env.HOME || require('os').homedir() } });
  activeTask = { taskId, process: claude, cancelled: false };
  claude.stdin.write(fullPrompt);
  claude.stdin.end();
  let result = '', chunk = '', stderr = '';
  claude.stdout.on('data', (d) => { const t = d.toString(); result += t; chunk += t; if (chunk.length >= 500) { send({ type: 'chunk', taskId, text: chunk }); chunk = ''; } });
  claude.stderr.on('data', (d) => { stderr += d.toString(); });
  claude.on('close', (code, signal) => {
    const wasCancelled = activeTask?.cancelled;
    activeTask = null;
    if (chunk) send({ type: 'chunk', taskId, text: chunk });
    if (wasCancelled) { send({ type: 'error', taskId, error: 'Cancelled by user' }); console.log(`🛑 Cancelled`); }
    else if (code === 0) { send({ type: 'complete', taskId, result }); console.log(`✅ Done (${result.length} chars)`); }
    else { const errMsg = result || stderr || `Exit ${code}${signal ? ' (' + signal + ')' : ''}`; send({ type: 'error', taskId, error: errMsg }); console.log(`❌ Failed (${code}): ${(stderr || result).slice(0, 300)}`); }
  });
  claude.on('error', (err) => { activeTask = null; send({ type: 'error', taskId, error: `Spawn failed: ${err.message}` }); });
}

function send(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
connect();
process.on('SIGINT', () => { ws?.close(); process.exit(0); });
WORKER_EOF

# ── Write config ──
# Auto-scan for git repos to populate projects list
PROJECTS_JSON="[]"
if command -v find &>/dev/null; then
  REPOS=$(find "$HOME" -maxdepth 3 -name ".git" -type d 2>/dev/null | sed 's/\/.git$//' | grep -v node_modules | grep -v '.Trash' | sort)
  if [ -n "$REPOS" ]; then
    PROJECTS_JSON="["
    FIRST=true
    for repo in $REPOS; do
      name=$(basename "$repo")
      if [ "$FIRST" = true ]; then FIRST=false; else PROJECTS_JSON+=","; fi
      PROJECTS_JSON+="{\"name\":\"$name\",\"path\":\"$repo\"}"
    done
    PROJECTS_JSON+="]"
  fi
fi

cat > "$INSTALL_DIR/config.json" << EOF
{
  "serverUrl": "$ANGEL_SERVER",
  "authToken": "$AUTH_TOKEN",
  "machineName": "$MACHINE_NAME",
  "defaultProject": "${PROJECT_DIR:-$HOME}",
  "projects": $PROJECTS_JSON
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

# ── Install as macOS Login Item (opens Terminal with worker on user login) ──
# We use Login Item (not LaunchAgent) because Claude CLI auth requires the
# user's GUI session Keychain. LaunchAgent runs in a context without Keychain
# access so Claude CLI would fail with "Not logged in". Login Items launch
# Terminal which inherits the full user session.
if [[ "$OSTYPE" == "darwin"* ]]; then
  LOGIN_APP="$INSTALL_DIR/AngelWorker.app"

  # Build a minimal .app bundle that runs start.sh in Terminal
  mkdir -p "$LOGIN_APP/Contents/MacOS"
  cat > "$LOGIN_APP/Contents/MacOS/AngelWorker" << APP_EOF
#!/bin/bash
# Open worker in a visible Terminal window so user can see status
osascript -e 'tell application "Terminal"
  activate
  do script "cd ~/.angel-worker && ./start.sh; echo; echo \"Worker exited. Press Enter to close.\"; read"
  set miniaturized of front window to true
end tell' > /dev/null 2>&1
APP_EOF
  chmod +x "$LOGIN_APP/Contents/MacOS/AngelWorker"

  cat > "$LOGIN_APP/Contents/Info.plist" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>AngelWorker</string>
  <key>CFBundleIdentifier</key><string>com.angel-ai.worker</string>
  <key>CFBundleName</key><string>Angel Worker</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST_EOF

  # Add to Login Items via osascript (requires one-time user approval)
  osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$LOGIN_APP\", hidden:false, name:\"Angel Worker\"}" 2>/dev/null && LOGIN_ITEM_INSTALLED=true
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Angel Worker installed to $INSTALL_DIR"
echo ""
if [ "$LOGIN_ITEM_INSTALLED" = true ]; then
  echo "✅ Login Item installed — worker will auto-start on every login"
  echo "   (opens in a minimized Terminal window)"
  echo ""
  echo "Built-in resilience:"
  echo "  • Heartbeat pings every 25s → prevents idle timeout"
  echo "  • Fast reconnect (1s x5) → survives server deploys"
  echo "  • Exponential backoff after → handles long outages"
  echo ""
  echo "Uninstall Login Item:"
  echo "  osascript -e 'tell application \"System Events\" to delete login item \"Angel Worker\"'"
fi
echo ""
echo "Logs:           tail -f $INSTALL_DIR/worker.log"
echo "Start manually: $INSTALL_DIR/start.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -t 0 ]; then
  read -p "🚀 Start worker now? (y/n) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    exec "$INSTALL_DIR/start.sh"
  fi
else
  echo "🚀 Starting Angel Worker..."
  exec "$INSTALL_DIR/start.sh"
fi
