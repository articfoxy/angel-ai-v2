/**
 * Diag — client pushes diagnostic state here every few seconds during
 * listening. We log to Railway so I can grep without relying on the user
 * to tail logs themselves.
 *
 *   POST /api/diag/audio  { frames, lastFrameAgoMs, recording, error?, wsState? }
 */
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';

export const diagRouter = Router();

// In-memory ring of the last 50 entries per user, exposed via GET so we can
// fetch even if Railway log tailing isn't available.
const RING_SIZE = 50;
const ring = new Map<string, Array<{ ts: number; data: Record<string, unknown> }>>();

diagRouter.post('/audio', (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
  const data = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  // Log to Railway — short prefix so it's grep-friendly: "[diag-audio]"
  const compact = JSON.stringify(data).slice(0, 400);
  console.log(`[diag-audio] ${req.userId.slice(0, 8)} ${compact}`);
  // Buffer in memory for GET fallback
  const entries = ring.get(req.userId) ?? [];
  entries.push({ ts: Date.now(), data });
  ring.set(req.userId, entries.slice(-RING_SIZE));
  res.json({ ok: true });
});

diagRouter.get('/audio', (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
  const entries = ring.get(req.userId) ?? [];
  res.json({ ok: true, entries });
});
