/**
 * Device token routes — push notification target registration.
 *
 *   POST /api/devices/register   { token, platform, deviceName?, appVersion? }
 *   DELETE /api/devices/:token   unregister
 *   GET /api/devices             list user's active devices
 */
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { prisma } from '../index';
import { pushService } from '../services/notifications/push.service';

export const devicesRouter = Router();

devicesRouter.post('/register', async (req: AuthRequest, res: Response) => {
  try {
    const { token, platform, deviceName, appVersion } = req.body || {};
    if (typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'token required' });
    }
    if (!['ios', 'android', 'web'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be ios/android/web' });
    }
    const id = await pushService.registerDevice({
      userId: req.userId!,
      token: String(token).slice(0, 500),
      platform,
      deviceName: deviceName ? String(deviceName).slice(0, 100) : undefined,
      appVersion: appVersion ? String(appVersion).slice(0, 50) : undefined,
    });
    res.json({ success: true, id });
  } catch (err: any) {
    console.error('[devices/register]', err?.message);
    res.status(500).json({ error: 'registration failed' });
  }
});

devicesRouter.delete('/:token', async (req: AuthRequest, res: Response) => {
  try {
    await pushService.unregisterDevice(req.userId!, String(req.params.token));
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'unregister failed' });
  }
});

devicesRouter.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.deviceToken.findMany({
      where: { userId: req.userId, status: 'active' },
      select: { id: true, platform: true, deviceName: true, appVersion: true, lastUsedAt: true, createdAt: true },
    });
    res.json({ success: true, data: rows });
  } catch {
    res.status(500).json({ error: 'fetch failed' });
  }
});

// Test endpoint — send a push to yourself (dev/debug only)
devicesRouter.post('/test', async (req: AuthRequest, res: Response) => {
  try {
    const result = await pushService.send({
      userId: req.userId!,
      title: '✨ Angel test',
      body: 'Push notifications are working!',
      category: 'insight',
      importance: 5,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'test failed' });
  }
});
