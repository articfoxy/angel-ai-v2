/**
 * Durable job runner (graphile-worker).
 *
 * Replaces the in-process setInterval cron with a Postgres-backed durable queue.
 * Jobs survive restarts, retry on failure, and can be scheduled via cron syntax.
 *
 * Why graphile-worker (not Temporal)?
 * - Same Postgres we already use — no new infra to run on Railway
 * - Typed tasks + retries + cron + batching
 * - Single-process-friendly (embed in the API server)
 * - Upgrade path: swap for Temporal later if durable saga semantics are needed
 *
 * Schedule (see CRONTAB below):
 *   every 15 min     — memory.working_state.ttl_sweep
 *   every 2 hours    — memory.candidate_promote
 *   daily 03:00 UTC  — memory.day_end_reflection
 *   daily 04:00 UTC  — memory.compaction (merge duplicates, expire stale)
 *   daily 05:00 UTC  — raw_archive.retention_sweep
 *   weekly Sun 06:00 — memory.decay (long-horizon pruning)
 */
import { run, type Runner, type Task, parseCrontab } from 'graphile-worker';
import { prisma } from '../../index';
import { WorkingStateService } from '../memory/working-state.service';
import { ReflectionService, CompactionService } from '../memory/reflection.service';
import { RawAssetService } from '../storage/raw-asset.service';

const connectionString = process.env.DATABASE_URL!;

let runner: Runner | null = null;

/** Task registry — one exported async function per job type. */
const tasks: Record<string, Task> = {
  // Working state TTL sweep — every 15 min
  'memory.working_state.ttl_sweep': async (_payload, helpers) => {
    const ws = new WorkingStateService();
    const count = await ws.purgeExpired();
    if (count > 0) helpers.logger.info(`ttl_sweep: purged ${count} expired rows`);
  },

  // Per-user reflection — fired daily by scheduler
  'memory.day_end_reflection': async (payload: any, helpers) => {
    const users = payload?.userId ? [{ id: String(payload.userId) }] : await prisma.user.findMany({ select: { id: true } });
    const reflection = new ReflectionService();
    let reflected = 0;
    for (const u of users) {
      try {
        const id = await reflection.reflectOnDay(u.id);
        if (id) reflected++;
      } catch (err: any) {
        helpers.logger.warn(`day_end user=${u.id.slice(0, 8)}: ${err?.message?.slice(0, 80)}`);
      }
    }
    helpers.logger.info(`day_end_reflection: ${reflected}/${users.length} users reflected`);
  },

  // Candidate → active promotion — every 2h
  'memory.candidate_promote': async (_payload, helpers) => {
    const users = await prisma.user.findMany({ select: { id: true } });
    const compaction = new CompactionService();
    let promoted = 0;
    for (const u of users) {
      try { promoted += await compaction.promoteCandidates(u.id); } catch {}
    }
    if (promoted > 0) helpers.logger.info(`candidate_promote: promoted ${promoted} across ${users.length} users`);
  },

  // Compaction — daily, merge duplicate candidates
  'memory.compaction': async (_payload, helpers) => {
    const users = await prisma.user.findMany({ select: { id: true } });
    const compaction = new CompactionService();
    let merged = 0;
    for (const u of users) {
      try { merged += await compaction.mergeDuplicateFacts(u.id); } catch {}
    }
    helpers.logger.info(`compaction: merged ${merged}`);
  },

  // Decay — weekly, expire stale low-importance facts + archive old observations
  'memory.decay': async (_payload, helpers) => {
    const users = await prisma.user.findMany({ select: { id: true } });
    const compaction = new CompactionService();
    let facts = 0, obs = 0;
    for (const u of users) {
      try {
        const res = await compaction.decay(u.id);
        facts += res.factsExpired; obs += res.obsArchived;
      } catch {}
    }
    helpers.logger.info(`decay: ${facts} facts expired, ${obs} obs archived`);
  },

  // Raw asset retention sweep — daily, delete past-retention archive objects
  'raw_archive.retention_sweep': async (_payload, helpers) => {
    const svc = new RawAssetService();
    if (!svc.isEnabled) { helpers.logger.debug('raw_archive disabled — skipping'); return; }
    const now = new Date();
    const expiredAssets = await prisma.rawAsset.findMany({
      where: { deleteAfter: { not: null, lte: now } },
      select: { id: true, uri: true },
      take: 500,
    });
    let deleted = 0;
    for (const a of expiredAssets) {
      try {
        await svc.delete(a.uri);
        await prisma.rawAsset.delete({ where: { id: a.id } });
        deleted++;
      } catch (err: any) {
        helpers.logger.warn(`retention_sweep ${a.id}: ${err?.message?.slice(0, 80)}`);
      }
    }
    if (deleted > 0) helpers.logger.info(`retention_sweep: deleted ${deleted} expired assets`);
  },

  // Re-embedding workflow — admin-triggered, batches active facts through new embedding model
  'memory.re_embed_facts': async (payload: any, helpers) => {
    const userId = String(payload?.userId || '');
    if (!userId) return;
    const { FactsService } = await import('../memory/facts.service');
    const { EmbeddingService } = await import('../memory/embeddings');
    const em = new EmbeddingService();
    if (!em.isAvailable) return;
    const batch = await prisma.fact.findMany({
      where: { userId, status: { in: ['active', 'candidate'] } },
      select: { id: true, content: true },
      take: 200,
    });
    for (const f of batch) {
      try {
        const vec = await em.embed(f.content);
        if (vec) {
          await prisma.$executeRawUnsafe(
            `UPDATE "Fact" SET embedding = $1::vector, "updatedAt" = NOW() WHERE id = $2`,
            em.toSqlVector(vec), f.id,
          );
        }
      } catch {}
    }
    helpers.logger.info(`re_embed_facts: user=${userId.slice(0, 8)} reembedded ${batch.length}`);
    // Self-reschedule if more remain
    if (batch.length >= 200) {
      await helpers.addJob('memory.re_embed_facts', { userId }, { runAt: new Date(Date.now() + 60_000) });
    }
  },

  // Forget workflow — tombstone + raw asset deletion for a user's query
  'memory.forget_workflow': async (payload: any, helpers) => {
    const { userId, entity, dateFrom, dateTo, modality, reason } = payload || {};
    if (!userId) return;
    const { FactsService } = await import('../memory/facts.service');
    const { EpisodeService } = await import('../memory/episode.service');
    const facts = new FactsService();
    const episodes = new EpisodeService();
    let count = 0;
    if (entity) count += await facts.forgetBySubject(userId, entity);
    if (dateFrom && dateTo) {
      const from = new Date(dateFrom), to = new Date(dateTo);
      count += await facts.forgetByDateRange(userId, from, to);
      count += await episodes.forgetByDateRange(userId, from, to);
    }
    if (modality) {
      const res = await prisma.observation.deleteMany({ where: { userId, modality } });
      count += res.count;
    }
    helpers.logger.info(`forget_workflow user=${userId.slice(0, 8)} reason=${reason || 'user'} forgotten=${count}`);
  },
};

const CRONTAB = `
# Working state TTL sweep — every 15 min
*/15 * * * * memory.working_state.ttl_sweep
# Candidate promotion — every 2 hours
0 */2 * * * memory.candidate_promote
# Day-end reflection — 03:00 UTC
0 3 * * * memory.day_end_reflection
# Compaction — 04:00 UTC
0 4 * * * memory.compaction
# Raw archive retention sweep — 05:00 UTC
0 5 * * * raw_archive.retention_sweep
# Decay — Sunday 06:00 UTC
0 6 * * 0 memory.decay
`.trim();

export async function startJobRunner(): Promise<void> {
  if (runner) return;
  if (!connectionString) {
    console.warn('[jobs] DATABASE_URL missing — job runner disabled');
    return;
  }
  try {
    runner = await run({
      connectionString,
      concurrency: 3,
      noHandleSignals: true, // main process manages signals
      pollInterval: 5000,
      parsedCronItems: parseCrontab(CRONTAB),
      taskList: tasks,
      noPreparedStatements: true, // Prisma+pg uses prepared; keep workers simple
    });
    console.log('[jobs] ✓ graphile-worker running with', Object.keys(tasks).length, 'tasks');
  } catch (err: any) {
    console.error('[jobs] failed to start:', err?.message?.slice(0, 200));
  }
}

export async function stopJobRunner(): Promise<void> {
  if (runner) {
    await runner.stop();
    runner = null;
  }
}

/** Public enqueue helper for one-shot jobs (forget, re-embed, etc). */
export async function enqueue(taskName: string, payload: any = {}, opts?: { runAt?: Date; priority?: number }): Promise<void> {
  if (!runner) return;
  await runner.addJob(taskName, payload, { runAt: opts?.runAt, priority: opts?.priority });
}
