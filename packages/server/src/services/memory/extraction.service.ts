/**
 * ExtractionService — v2 compatibility shim.
 *
 * Old v1 API called `ExtractionService.processSession(sessionId, userId)` at
 * session end to extract facts/entities/relationships/reflections. The v2
 * pipeline does this continuously via observations + the memory judge, so
 * processSession now just:
 *   1. Runs the judge on any remaining unprocessed observations for the session
 *   2. Returns a summary compatible with the old caller signature
 *
 * Still exported so socket.service.ts doesn't break while we migrate its
 * call sites to use `MemoryJudgeService` + `ReflectionService` directly.
 */
import { prisma } from '../../index';
import { MemoryJudgeService } from './judge.service';

export class ExtractionService {
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  async processSession(sessionId: string, userId: string): Promise<{
    summary: string;
    memoriesExtracted: number;
    entitiesFound: number;
    duration: number | null;
  }> {
    const start = Date.now();

    // Flush all unprocessed observations for this session via the judge
    const judge = new MemoryJudgeService(this.apiKey);
    const res = await judge.run({ userId, sessionId, trigger: { kind: 'session_end', sessionId } });

    // Pull the episode summary (if one was created) as the session summary
    const latestEpisode = await prisma.episode.findFirst({
      where: { userId, sessionId, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    const summary = latestEpisode?.summary ?? 'Session completed';

    return {
      summary,
      memoriesExtracted: res.factsAdded + res.factsUpdated + res.factsSuperseded,
      entitiesFound: 0, // entities handled inside the judge; we don't surface a count here
      duration: Math.round((Date.now() - start) / 1000),
    };
  }
}
