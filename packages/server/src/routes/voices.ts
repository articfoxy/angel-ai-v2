import { Router, Request, Response } from 'express';

export const voicesRouter = Router();

interface Voice {
  id: string;
  name: string;
  description: string;
  language: string;
}

let cachedVoices: Voice[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

voicesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const apiKey = process.env.CARTESIA_API_KEY;
    if (!apiKey) {
      return res.json([]);
    }

    const now = Date.now();
    if (cachedVoices && now - cacheTimestamp < CACHE_TTL_MS) {
      return res.json(cachedVoices);
    }

    const response = await fetch('https://api.cartesia.ai/voices', {
      headers: {
        'X-API-Key': apiKey,
        'Cartesia-Version': '2024-12-12',
      },
    });

    if (!response.ok) {
      console.error(`[voices] Cartesia API error: ${response.status} ${response.statusText}`);
      // Return stale cache if available, otherwise empty
      return res.json(cachedVoices ?? []);
    }

    const data: any = await response.json();
    const voiceList = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];

    const voices: Voice[] = voiceList.map((v: any) => ({
      id: v.id,
      name: v.name,
      description: v.description ?? '',
      language: v.language ?? '',
    }));

    cachedVoices = voices;
    cacheTimestamp = now;

    return res.json(voices);
  } catch (err) {
    console.error('[voices] Failed to fetch voices from Cartesia:', err);
    return res.json(cachedVoices ?? []);
  }
});

voicesRouter.get('/preview/:voiceId', async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.CARTESIA_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Voice preview unavailable: TTS service not configured' });
    }

    const { voiceId } = req.params;

    const ttsResponse = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Cartesia-Version': '2024-12-12',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: 'sonic-2024-12-12',
        transcript:
          "Hello, I'm your Angel assistant. I'll whisper helpful insights during your conversations.",
        voice: { mode: 'id', id: voiceId },
        output_format: {
          container: 'wav',
          encoding: 'pcm_s16le',
          sample_rate: 24000,
        },
      }),
    });

    if (!ttsResponse.ok) {
      console.error(
        `[voices] Cartesia TTS error: ${ttsResponse.status} ${ttsResponse.statusText}`,
      );
      return res
        .status(ttsResponse.status)
        .json({ error: `TTS request failed: ${ttsResponse.statusText}` });
    }

    const audioBytes = Buffer.from(await ttsResponse.arrayBuffer());
    res.set('Content-Type', 'audio/wav');
    return res.send(audioBytes);
  } catch (err) {
    console.error('[voices] Voice preview failed:', err);
    return res.status(500).json({ error: 'Voice preview failed' });
  }
});
