import { Router, Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { extractAveragedFeatures } from '../services/audio-features.service';
import { prisma } from '../index';

const router = Router();

// POST /enroll — enroll or update voiceprint from base64 PCM audio
router.post('/enroll', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { audio } = req.body as { audio: string };

    if (!audio || typeof audio !== 'string') {
      res.status(400).json({ error: 'Missing or invalid audio field (expected base64 PCM string)' });
      return;
    }

    const pcmBuffer = Buffer.from(audio, 'base64');

    // ~400KB minimum for roughly 15 seconds of 16-bit 16kHz mono PCM
    const MIN_AUDIO_BYTES = 400_000;
    if (pcmBuffer.length < MIN_AUDIO_BYTES) {
      res.status(400).json({
        error: `Audio too short. Need at least ~15 seconds (${MIN_AUDIO_BYTES} bytes), got ${pcmBuffer.length} bytes.`,
      });
      return;
    }

    // Split PCM buffer into 1024-sample frames (2048 bytes each) with 512-sample hop (1024 bytes)
    // extractAveragedFeatures expects Buffer[] of raw linear16 PCM
    const frameSizeBytes = 1024 * 2; // 1024 samples × 2 bytes per sample
    const hopSizeBytes = 512 * 2;
    const frames: Buffer[] = [];
    for (let offset = 0; offset + frameSizeBytes <= pcmBuffer.length; offset += hopSizeBytes) {
      frames.push(pcmBuffer.subarray(offset, offset + frameSizeBytes));
    }

    const features = extractAveragedFeatures(frames);

    const voiceprint = await prisma.voiceprint.upsert({
      where: { userId },
      create: {
        userId,
        features: features as any,
        sampleCount: frames.length,
      },
      update: {
        features: features as any,
        sampleCount: frames.length,
      },
    });

    res.json({
      enrolled: true,
      voiceprint: {
        id: voiceprint.id,
        sampleCount: voiceprint.sampleCount,
        createdAt: voiceprint.createdAt,
        updatedAt: voiceprint.updatedAt,
      },
    });
  } catch (err: any) {
    console.error('Voiceprint enroll error:', err);
    res.status(500).json({ error: 'Failed to enroll voiceprint' });
  }
});

// GET /status — check if user has an enrolled voiceprint
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const voiceprint = await prisma.voiceprint.findUnique({
      where: { userId },
      select: { id: true, sampleCount: true, createdAt: true, updatedAt: true },
    });

    res.json({
      enrolled: !!voiceprint,
      voiceprint: voiceprint || null,
    });
  } catch (err: any) {
    console.error('Voiceprint status error:', err);
    res.status(500).json({ error: 'Failed to check voiceprint status' });
  }
});

// DELETE / — remove voiceprint for user
router.delete('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    await prisma.voiceprint.deleteMany({ where: { userId } });

    res.json({ deleted: true });
  } catch (err: any) {
    console.error('Voiceprint delete error:', err);
    res.status(500).json({ error: 'Failed to delete voiceprint' });
  }
});

export { router as voiceprintRouter };
