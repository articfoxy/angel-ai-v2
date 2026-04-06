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

export async function connectSocket(): Promise<Socket> {
  const token = await getStoredToken();
  if (!token) throw new Error('Not authenticated');

  if (socket?.connected) return socket;

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  socket = io(WS_URL, {
    auth: async (cb) => {
      const currentToken = await getStoredToken();
      cb({ token: currentToken });
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  });

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

  socket.io.on('reconnect', async (attemptNumber) => {
    console.log('[socket] reconnected after', attemptNumber, 'attempts');
    // Re-fetch latest token in case it was refreshed while disconnected
    const freshToken = await getStoredToken();
    if (socket && freshToken) {
      socket.auth = { token: freshToken };
    }
    notifyStateChange(true);
  });

  socket.io.on('reconnect_attempt', (attemptNumber) => {
    console.log('[socket] reconnect attempt', attemptNumber);
  });

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
