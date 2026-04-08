import { io, Socket } from 'socket.io-client';
import { WS_URL } from '../config';
import { getStoredToken } from './auth';

let socket: Socket | null = null;

type StateChangeCallback = (connected: boolean) => void;
const stateChangeListeners = new Set<StateChangeCallback>();

function notifyStateChange(connected: boolean) {
  stateChangeListeners.forEach((cb) => cb(connected));
}

/**
 * Subscribe to socket connection state changes.
 * Returns an unsubscribe function.
 */
export function onSocketStateChange(callback: StateChangeCallback): () => void {
  stateChangeListeners.add(callback);
  return () => {
    stateChangeListeners.delete(callback);
  };
}

const CONNECT_TIMEOUT_MS = 8000;

export async function connectSocket(): Promise<Socket> {
  const token = await getStoredToken();
  if (!token) throw new Error('Not authenticated');

  if (socket?.connected) return socket;

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  const newSocket = io(WS_URL, {
    auth: async (cb) => {
      const currentToken = await getStoredToken();
      cb({ token: currentToken });
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  });

  // Wait for the socket to actually connect before returning.
  // This prevents audio from being emitted to an unconnected socket.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      newSocket.disconnect();
      reject(new Error('Socket connection timed out'));
    }, CONNECT_TIMEOUT_MS);

    newSocket.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });

    newSocket.once('connect_error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Socket connection failed: ${err.message}`));
    });
  });

  socket = newSocket;

  socket.on('connect', () => {
    console.log('[socket] connected, id:', socket?.id);
    notifyStateChange(true);
  });

  socket.on('disconnect', (reason) => {
    console.log('[socket] disconnected, reason:', reason);
    notifyStateChange(false);
  });

  socket.on('connect_error', (err) => {
    console.warn('[socket] connect_error:', err.message);
  });

  socket.io.on('reconnect', (attemptNumber) => {
    console.log('[socket] reconnected after', attemptNumber, 'attempts');
    // Keep auth as an async callback so socket.io fetches a fresh token
    // on each subsequent reconnect (don't overwrite with a static object)
    notifyStateChange(true);
  });

  socket.io.on('reconnect_attempt', (attemptNumber) => {
    console.log('[socket] reconnect attempt', attemptNumber);
  });

  console.log('[socket] connected successfully, id:', socket.id);
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
