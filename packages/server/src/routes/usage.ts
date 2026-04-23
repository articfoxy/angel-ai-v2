/**
 * Usage routes — token + cost tracking for the Settings screen.
 *
 *   GET /api/usage?period=today|week|month|all
 *     Returns aggregated token usage over the window, broken out by
 *     provider / operation / model, with denormalized USD cost.
 */
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { usageService } from '../services/usage.service';

export const usageRouter = Router();

type Period = 'today' | 'week' | 'month' | 'all';

function windowFor(period: Period): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date();
  switch (period) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'week':
      start.setDate(start.getDate() - 7);
      break;
    case 'month':
      start.setDate(start.getDate() - 30);
      break;
    case 'all':
    default:
      start.setFullYear(2000); // effectively "all time"
      break;
  }
  return { start, end };
}

usageRouter.get('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const raw = (req.query.period as string) || 'today';
    const period: Period = (['today', 'week', 'month', 'all'].includes(raw) ? raw : 'today') as Period;
    const { start, end } = windowFor(period);
    const summary = await usageService.summarize(req.userId, start, end);
    res.json({ success: true, period, ...summary });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch usage' });
  }
});
