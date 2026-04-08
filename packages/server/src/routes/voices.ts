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

    const data = await response.json();
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
