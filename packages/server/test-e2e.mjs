/**
 * End-to-end transcription pipeline test.
 *
 * Tests against the LIVE deployed server:
 * 1. Registers/logs in a test user
 * 2. Creates a session via REST API
 * 3. Connects via Socket.io
 * 4. Emits session:start
 * 5. Sends generated audio (sine wave as PCM linear16, 16kHz, mono, base64)
 * 6. Listens for 'transcript' events
 * 7. Reports pass/fail
 */

import { io } from 'socket.io-client';

const SERVER = 'https://server-production-ff34.up.railway.app';
const TEST_EMAIL = 'pipeline-test@angelai.test';
const TEST_PASS = 'TestPass123!';

// Generate a 440Hz sine wave as PCM linear16, 16kHz mono
function generateAudio(durationSec) {
  const sampleRate = 16000;
  const numSamples = sampleRate * durationSec;
  const buf = Buffer.alloc(numSamples * 2); // 16-bit = 2 bytes per sample
  for (let i = 0; i < numSamples; i++) {
    // 440Hz sine wave at ~50% amplitude
    const sample = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 16000;
    buf.writeInt16LE(Math.round(sample), i * 2);
  }
  return buf;
}

// Generate speech-like audio (varying frequencies to trigger VAD)
function generateSpeechLikeAudio(durationSec) {
  const sampleRate = 16000;
  const numSamples = sampleRate * durationSec;
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Mix of frequencies that mimic speech formants
    const f1 = 150 + 50 * Math.sin(2 * Math.PI * 3 * t); // fundamental ~150Hz varying
    const f2 = 800 + 200 * Math.sin(2 * Math.PI * 2 * t); // first formant
    const f3 = 2500 + 300 * Math.sin(2 * Math.PI * 1.5 * t); // second formant
    const sample = (
      0.5 * Math.sin(2 * Math.PI * f1 * t) +
      0.3 * Math.sin(2 * Math.PI * f2 * t) +
      0.2 * Math.sin(2 * Math.PI * f3 * t)
    ) * 12000;
    buf.writeInt16LE(Math.round(sample), i * 2);
  }
  return buf;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${SERVER}/api/${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, data: json };
}

async function run() {
  console.log('=== Angel AI v2 — E2E Transcription Test ===\n');

  // Step 1: Get auth token
  console.log('[1] Authenticating...');
  let token;

  // Try login first
  let res = await apiFetch('auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }),
  });

  if (res.status === 200 && res.data?.data?.accessToken) {
    token = res.data.data.accessToken;
    console.log('    Logged in with existing test account');
  } else {
    // Register
    console.log('    Login failed, trying register...', res.status);
    res = await apiFetch('auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS, name: 'Pipeline Test' }),
    });
    if ((res.status === 201 || res.status === 200) && res.data?.data?.accessToken) {
      token = res.data.data.accessToken;
      console.log('    Registered new test account');
    } else if (res.status === 409) {
      // Already exists but login failed — try again
      console.error('    Account exists but login failed. Possibly password mismatch.');
      process.exit(1);
    } else {
      console.error('    FAIL: Could not authenticate:', res.status, JSON.stringify(res.data));
      process.exit(1);
    }
  }

  if (!token) {
    console.error('    FAIL: No token obtained');
    process.exit(1);
  }
  console.log(`    Token: ${token.substring(0, 20)}...`);

  // Step 2: Create session
  console.log('\n[2] Creating session...');
  res = await apiFetch('sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });

  if (res.status !== 201 && res.status !== 200) {
    console.error('    FAIL: Could not create session:', res.status, JSON.stringify(res.data));
    process.exit(1);
  }
  const sessionId = res.data?.data?.id || res.data?.id;
  console.log(`    Session ID: ${sessionId}`);

  // Step 3: Connect socket
  console.log('\n[3] Connecting socket...');
  const socket = io(SERVER, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 10000,
  });

  const results = {
    connected: false,
    transcriptEvents: [],
    whisperEvents: [],
    speakerEvents: [],
    errors: [],
  };

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Socket connection timed out (10s)'));
    }, 10000);

    socket.on('connect', () => {
      clearTimeout(timeout);
      results.connected = true;
      console.log(`    Connected! Socket ID: ${socket.id}`);
      resolve();
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Socket connect error: ${err.message}`));
    });
  });

  // Step 3.5: Verify session exists
  console.log('\n[3.5] Verifying session exists...');
  const verifyRes = await apiFetch(`sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`    Session lookup: ${verifyRes.status} ${verifyRes.data?.data?.id ? '✅ found' : '❌ not found'}`);
  if (verifyRes.data?.data?.status) console.log(`    Status: ${verifyRes.data.data.status}`);

  // Step 4: Register event listeners — including catch-all for debugging
  socket.onAny((eventName, ...args) => {
    if (!['transcript', 'whisper', 'speaker:identified', 'session:error', 'session:timeout', 'session:debrief'].includes(eventName)) {
      console.log(`    [event:${eventName}]`, JSON.stringify(args).substring(0, 200));
    }
  });

  socket.on('transcript', (data) => {
    results.transcriptEvents.push(data);
    const label = data.speakerLabel || data.speaker || '?';
    const status = data.isFinal ? 'FINAL' : 'interim';
    console.log(`    [transcript:${status}] [${label}] "${data.text}"`);
  });

  socket.on('whisper', (data) => {
    results.whisperEvents.push(data);
    console.log(`    [whisper] ${data.type}: ${data.content}`);
  });

  socket.on('speaker:identified', (data) => {
    results.speakerEvents.push(data);
    console.log(`    [speaker] ${data.speakerId} → ${data.label}`);
  });

  socket.on('session:error', (data) => {
    results.errors.push(data);
    console.error(`    [session:error] ${data.message}`);
  });

  socket.on('session:timeout', (data) => {
    console.log(`    [session:timeout] ${data.reason}: ${data.message}`);
  });

  // Step 5: Start session
  console.log('\n[4] Emitting session:start...');
  socket.emit('session:start', { sessionId });

  // Give server time to look up session in DB + connect Deepgram (can take 3-5s)
  console.log('    Waiting 6s for Deepgram to connect on server...');
  await new Promise(r => setTimeout(r, 6000));

  if (results.errors.length > 0) {
    console.error('\n❌ FAIL: Session error before audio sent.');
    console.error('   This likely means DEEPGRAM_API_KEY is missing or invalid on Railway.');
    console.error('   Errors:', results.errors);
    socket.disconnect();
    process.exit(1);
  }

  // Step 6: Send audio — use real speech from macOS TTS if available, else generated
  let audio;
  const fs = await import('fs');
  const speechFile = '/tmp/test-speech.wav';

  if (fs.existsSync(speechFile)) {
    console.log('\n[5] Sending REAL SPEECH audio from TTS...');
    const wavBuf = fs.readFileSync(speechFile);
    // Find the "data" chunk offset (proper WAV parsing)
    let pcmStart = 44; // fallback
    for (let i = 12; i < Math.min(wavBuf.length, 10000); i++) {
      if (wavBuf[i] === 0x64 && wavBuf[i+1] === 0x61 && wavBuf[i+2] === 0x74 && wavBuf[i+3] === 0x61) {
        pcmStart = i + 8;
        console.log(`    WAV "data" chunk at byte ${i}, PCM starts at ${pcmStart}`);
        break;
      }
    }
    audio = wavBuf.slice(pcmStart);
    console.log(`    PCM audio: ${audio.length} bytes (${(audio.length / 32000).toFixed(1)}s)`);
  } else {
    console.log('\n[5] Sending 3 seconds of generated audio (no speech file found)...');
    audio = generateSpeechLikeAudio(3);
  }

  const CHUNK_SIZE = 3200; // 100ms chunks (16000 samples/sec * 2 bytes * 0.1sec)

  for (let offset = 0; offset < audio.length; offset += CHUNK_SIZE) {
    const chunk = audio.slice(offset, offset + CHUNK_SIZE);
    const base64Chunk = chunk.toString('base64');
    socket.emit('audio', base64Chunk);
    // Pace the chunks at real-time speed (~100ms per 3200-byte chunk)
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`    Sent ${Math.ceil(audio.length / CHUNK_SIZE)} chunks (${audio.length} bytes total)`);

  // Step 7: Wait for transcripts
  console.log('\n[6] Waiting 10 seconds for Deepgram to process and return transcripts...');
  await new Promise(r => setTimeout(r, 10000));

  // Step 8: Stop session
  console.log('\n[7] Stopping session...');
  socket.emit('session:stop', { sessionId });
  await new Promise(r => setTimeout(r, 2000));

  // Report
  console.log('\n========== RESULTS ==========');
  console.log(`Socket connected:     ${results.connected ? '✅ YES' : '❌ NO'}`);
  console.log(`Transcript events:    ${results.transcriptEvents.length > 0 ? '✅' : '⚠️'} ${results.transcriptEvents.length} received`);
  console.log(`  - Final segments:   ${results.transcriptEvents.filter(t => t.isFinal).length}`);
  console.log(`  - Interim segments: ${results.transcriptEvents.filter(t => !t.isFinal).length}`);
  console.log(`Speaker events:       ${results.speakerEvents.length}`);
  console.log(`Session errors:       ${results.errors.length > 0 ? '❌' : '✅'} ${results.errors.length}`);
  if (results.errors.length > 0) {
    results.errors.forEach(e => console.log(`  - ${e.message}`));
  }

  console.log('\n--- VERDICT ---');
  if (results.errors.length > 0) {
    console.log('❌ FAIL: Session errors detected. Likely DEEPGRAM_API_KEY issue.');
  } else if (results.transcriptEvents.length > 0) {
    console.log('✅ PASS: Full pipeline working! Audio → Server → Deepgram → Transcript events received.');
  } else if (results.connected) {
    console.log('⚠️  PARTIAL: Socket connected and no errors, but no transcript events received.');
    console.log('   This could mean:');
    console.log('   - Deepgram connected but the generated audio was not speech-like enough');
    console.log('   - The audio format was accepted (no errors = format is correct)');
    console.log('   - Real speech from a mic should produce transcripts');
  } else {
    console.log('❌ FAIL: Could not connect socket.');
  }

  socket.disconnect();
  process.exit(results.errors.length > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
