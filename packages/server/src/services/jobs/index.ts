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
import { run, type Runner, type Task, parseCronItems } from 'graphile-worker';
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

  // Per-user reflection — fires sub-jobs instead of iterating inline.
  // Prevents single-tick OOM at scale; graphile-worker handles concurrency.
  'memory.day_end_reflection': async (payload: any, helpers) => {
    if (payload?.userId) {
      // Sub-invocation: delegate to per-user task
      await helpers.addJob('memory.user.reflect', { userId: String(payload.userId) });
      return;
    }
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) await helpers.addJob('memory.user.reflect', { userId: u.id }, { priority: 5 });
    helpers.logger.info(`day_end_reflection: fanned out to ${users.length} users`);
  },

  'memory.candidate_promote': async (_payload, helpers) => {
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) await helpers.addJob('memory.user.compact', { userId: u.id }, { priority: 4 });
    if (users.length > 0) helpers.logger.info(`candidate_promote: fanned out to ${users.length} users`);
  },

  'memory.compaction': async (_payload, helpers) => {
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) await helpers.addJob('memory.user.compact', { userId: u.id }, { priority: 4 });
    helpers.logger.info(`compaction: fanned out to ${users.length} users`);
  },

  'memory.decay': async (_payload, helpers) => {
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) await helpers.addJob('memory.user.decay', { userId: u.id }, { priority: 3 });
    helpers.logger.info(`decay: fanned out to ${users.length} users`);
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
    const { RawAssetService } = await import('../storage/raw-asset.service');
    const facts = new FactsService();
    const episodes = new EpisodeService();
    const rawAssets = new RawAssetService();
    let count = 0;

    // 1. Soft-forget facts + episodes (preserves audit chain)
    if (entity) count += await facts.forgetBySubject(userId, entity);
    if (dateFrom && dateTo) {
      const from = new Date(dateFrom), to = new Date(dateTo);
      count += await facts.forgetByDateRange(userId, from, to);
      count += await episodes.forgetByDateRange(userId, from, to);
    }

    // 2. For observations matching modality/date — collect their contentRef
    //    URIs so we can purge S3 blobs before hard-deleting the rows.
    if (modality || (dateFrom && dateTo)) {
      const obsWhere: any = { userId };
      if (modality) obsWhere.modality = modality;
      if (dateFrom && dateTo) obsWhere.observedAt = { gte: new Date(dateFrom), lte: new Date(dateTo) };
      const obsWithMedia = await prisma.observation.findMany({
        where: { ...obsWhere, contentRef: { not: null } },
        select: { contentRef: true },
      });
      // Purge raw archive blobs + their metadata rows
      for (const { contentRef } of obsWithMedia) {
        if (!contentRef) continue;
        try {
          if (rawAssets.isEnabled) await rawAssets.delete(contentRef);
          await prisma.rawAsset.deleteMany({ where: { userId, uri: contentRef } });
        } catch (err: any) {
          helpers.logger.warn(`raw-asset purge ${contentRef}: ${err?.message?.slice(0, 80)}`);
        }
      }
      // Collect deleted observation IDs BEFORE hard-deleting so we can scrub
      // provenance arrays afterward
      const toDelete = await prisma.observation.findMany({
        where: obsWhere,
        select: { id: true },
      });
      const deletedIds = toDelete.map((o) => o.id);

      // Hard-delete the observations
      const res = await prisma.observation.deleteMany({ where: obsWhere });
      count += res.count;

      // Scrub now-dangling sourceObservationIds references in Facts + Episodes.
      // Postgres array_remove cleanly filters out the deleted ids per row.
      if (deletedIds.length > 0) {
        for (const obsId of deletedIds) {
          await prisma.$executeRawUnsafe(
            `UPDATE "Fact" SET "sourceObservationIds" = array_remove("sourceObservationIds", $1) WHERE "userId" = $2 AND $1 = ANY("sourceObservationIds")`,
            obsId, userId,
          ).catch(() => {});
          await prisma.$executeRawUnsafe(
            `UPDATE "Episode" SET "sourceObservationIds" = array_remove("sourceObservationIds", $1) WHERE "userId" = $2 AND $1 = ANY("sourceObservationIds")`,
            obsId, userId,
          ).catch(() => {});
        }
      }
    }

    // 3. Audit trail — record the forget operation (outlives the data)
    await prisma.memoryAuditLog.create({
      data: {
        userId,
        actorType: 'user',
        operation: 'forget',
        memoryType: 'observation',
        memoryId: `forget-${Date.now()}`,
        reason: reason || 'user-initiated',
        after: { entity, dateFrom, dateTo, modality, forgottenCount: count },
      },
    }).catch(() => {});

    helpers.logger.info(`forget_workflow user=${userId.slice(0, 8)} reason=${reason || 'user'} forgotten=${count}`);
  },

  // Audit log retention — prune old audit records
  'memory.audit_prune': async (_payload, helpers) => {
    const retentionAuditCutoff = new Date(Date.now() - 30 * 24 * 3_600_000);  // 30d
    const memoryAuditCutoff    = new Date(Date.now() - 90 * 24 * 3_600_000);  // 90d
    const [retrievalRes, memoryRes] = await Promise.all([
      prisma.retrievalAudit.deleteMany({ where: { createdAt: { lt: retentionAuditCutoff } } }),
      // Keep 'forget' operation audits indefinitely (GDPR)
      prisma.memoryAuditLog.deleteMany({
        where: { createdAt: { lt: memoryAuditCutoff }, operation: { not: 'forget' } },
      }),
    ]);
    helpers.logger.info(`audit_prune: retrieval=${retrievalRes.count}, memory=${memoryRes.count}`);
  },

  // Per-user fanout for reflection/decay — prevents single-tick OOM at scale
  'memory.user.reflect': async (payload: any, helpers) => {
    const userId = String(payload?.userId || '');
    if (!userId) return;
    const { ReflectionService } = await import('../memory/reflection.service');
    const reflection = new ReflectionService();
    try { await reflection.reflectOnDay(userId); }
    catch (e: any) { helpers.logger.warn(`reflect user=${userId.slice(0, 8)}: ${e?.message?.slice(0, 80)}`); }
  },

  'memory.user.compact': async (payload: any, helpers) => {
    const userId = String(payload?.userId || '');
    if (!userId) return;
    const { CompactionService } = await import('../memory/reflection.service');
    const c = new CompactionService();
    try {
      const promoted = await c.promoteCandidates(userId);
      const merged = await c.mergeDuplicateFacts(userId);
      const promotedProcs = await c.promoteProcedures(userId);
      if (promoted || merged || promotedProcs) {
        helpers.logger.info(`compact user=${userId.slice(0, 8)}: facts +${promoted}/~${merged}, procs +${promotedProcs}`);
      }
    } catch (e: any) { helpers.logger.warn(`compact user=${userId.slice(0, 8)}: ${e?.message?.slice(0, 80)}`); }
  },

  'memory.user.decay': async (payload: any, helpers) => {
    const userId = String(payload?.userId || '');
    if (!userId) return;
    const { CompactionService } = await import('../memory/reflection.service');
    const c = new CompactionService();
    try {
      const res = await c.decay(userId);
      if (res.factsExpired || res.obsArchived) helpers.logger.info(`decay user=${userId.slice(0, 8)}: ${res.factsExpired} expired, ${res.obsArchived} archived`);
    } catch (e: any) { helpers.logger.warn(`decay user=${userId.slice(0, 8)}: ${e?.message?.slice(0, 80)}`); }
  },

  // ─── PHASE E CADENCE JOBS ─────────────────────────────────────────────────
  // Digests run as per-user sub-jobs so they parallelize cleanly

  'digest.morning.all': async (_payload, helpers) => {
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) await helpers.addJob('digest.morning.user', { userId: u.id }, { priority: 6 });
    helpers.logger.info(`digest.morning: fanned out to ${users.length} users`);
  },

  'digest.evening.all': async (_payload, helpers) => {
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) await helpers.addJob('digest.evening.user', { userId: u.id }, { priority: 6 });
    helpers.logger.info(`digest.evening: fanned out to ${users.length} users`);
  },

  'digest.weekly.all': async (_payload, helpers) => {
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) await helpers.addJob('digest.weekly.user', { userId: u.id }, { priority: 7 });
    helpers.logger.info(`digest.weekly: fanned out to ${users.length} users`);
  },

  'digest.morning.user': async (payload: any, helpers) => {
    const userId = String(payload?.userId || '');
    if (!userId) return;
    const { DigestComposer } = await import('../notifications/digest-composer.service');
    const c = new DigestComposer();
    try {
      const id = await c.composeAndDeliver(userId, 'morning');
      if (id) helpers.logger.info(`digest.morning user=${userId.slice(0, 8)}: ${id.slice(0, 8)}`);
    } catch (e: any) { helpers.logger.warn(`digest.morning user=${userId.slice(0, 8)}: ${e?.message?.slice(0, 80)}`); }
  },

  'digest.evening.user': async (payload: any, helpers) => {
    const userId = String(payload?.userId || '');
    if (!userId) return;
    const { DigestComposer } = await import('../notifications/digest-composer.service');
    const c = new DigestComposer();
    try {
      const id = await c.composeAndDeliver(userId, 'evening');
      if (id) helpers.logger.info(`digest.evening user=${userId.slice(0, 8)}: ${id.slice(0, 8)}`);
    } catch (e: any) { helpers.logger.warn(`digest.evening user=${userId.slice(0, 8)}: ${e?.message?.slice(0, 80)}`); }
  },

  'digest.weekly.user': async (payload: any, helpers) => {
    const userId = String(payload?.userId || '');
    if (!userId) return;
    const { DigestComposer } = await import('../notifications/digest-composer.service');
    const c = new DigestComposer();
    try {
      const id = await c.composeAndDeliver(userId, 'weekly');
      if (id) helpers.logger.info(`digest.weekly user=${userId.slice(0, 8)}: ${id.slice(0, 8)}`);
    } catch (e: any) { helpers.logger.warn(`digest.weekly user=${userId.slice(0, 8)}: ${e?.message?.slice(0, 80)}`); }
  },
};

// Cron schedule built programmatically. Each item = one cron rule.
// graphile-worker's parseCronItems accepts structured objects — more robust
// than parseCrontab which has picky string parsing.
const CRON_ITEMS = parseCronItems([
  { task: 'memory.working_state.ttl_sweep', match: '*/15 * * * *', identifier: 'ttl-sweep' },
  { task: 'memory.candidate_promote',       match: '0 */2 * * *', identifier: 'promote' },
  { task: 'memory.day_end_reflection',       match: '0 3 * * *',   identifier: 'day-end' },
  { task: 'memory.compaction',               match: '0 4 * * *',   identifier: 'compaction' },
  { task: 'raw_archive.retention_sweep',     match: '0 5 * * *',   identifier: 'retention' },
  { task: 'memory.decay',                    match: '0 6 * * 0',   identifier: 'decay' },
  { task: 'memory.audit_prune',              match: '0 7 * * *',   identifier: 'audit-prune' },
  // Phase E — cadence digests (UTC; adjust to user timezone in future)
  { task: 'digest.morning.all',              match: '0 13 * * *',  identifier: 'morning' },  // 7am ET / 8pm HKT-ish
  { task: 'digest.evening.all',              match: '0 1 * * *',   identifier: 'evening' },  // 7pm ET
  { task: 'digest.weekly.all',               match: '0 0 * * 1',   identifier: 'weekly' },   // Sun 7pm ET
]);

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
      parsedCronItems: CRON_ITEMS,
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

/** Is the job runner currently alive? Used by /health/ready. */
export function isJobRunnerAlive(): boolean {
  return runner !== null;
}
