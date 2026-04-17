/**
 * In-process memory cron — nightly reflection, decay, compaction, TTL sweep.
 *
 * v1 uses a single setInterval rather than graphile-worker/Temporal because
 * we have one Node process and one database. Upgrade path: swap `startMemoryCron`
 * for graphile-worker if/when we fan out to multiple workers.
 *
 * Schedule:
 *   every 6h: working state TTL sweep
 *   every 24h: per-user day_end reflection + compaction + candidate promotion
 *   every 72h: decay (soft-expire stale facts, archive old observations)
 */
import { prisma } from '../../index';
import { ReflectionService, CompactionService } from './reflection.service';
import { WorkingStateService } from './working-state.service';

const SIX_HOURS = 6 * 60 * 60_000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60_000;
const SEVENTY_TWO_HOURS = 72 * 60 * 60_000;

let timers: ReturnType<typeof setInterval>[] = [];

/** Start the periodic memory jobs. Safe to call once on server boot. */
export function startMemoryCron() {
  console.log('[memory-cron] starting jobs');

  // (1) TTL sweep — every 6h
  const ttlTimer = setInterval(async () => {
    try {
      const ws = new WorkingStateService();
      const count = await ws.purgeExpired();
      if (count > 0) console.log(`[memory-cron] working_state TTL sweep: purged ${count}`);
    } catch (e) {
      console.warn('[memory-cron] TTL sweep failed:', (e as any)?.message);
    }
  }, SIX_HOURS);
  timers.push(ttlTimer);

  // (2) Day-end reflection + compaction — every 24h
  const dayTimer = setInterval(async () => {
    try {
      const users = await prisma.user.findMany({ select: { id: true } });
      const reflection = new ReflectionService();
      const compaction = new CompactionService();
      for (const u of users) {
        try {
          await reflection.reflectOnDay(u.id);
          const promoted = await compaction.promoteCandidates(u.id);
          const merged = await compaction.mergeDuplicateFacts(u.id);
          if (promoted || merged) {
            console.log(`[memory-cron] user ${u.id.slice(0, 8)}: promoted ${promoted}, merged ${merged}`);
          }
        } catch (err) {
          console.warn(`[memory-cron] user ${u.id}: ${(err as any)?.message?.slice(0, 80)}`);
        }
      }
    } catch (e) {
      console.warn('[memory-cron] day-end failed:', (e as any)?.message);
    }
  }, TWENTY_FOUR_HOURS);
  timers.push(dayTimer);

  // (3) Decay — every 72h (longer cycle, bigger scan)
  const decayTimer = setInterval(async () => {
    try {
      const users = await prisma.user.findMany({ select: { id: true } });
      const compaction = new CompactionService();
      for (const u of users) {
        try {
          const res = await compaction.decay(u.id);
          if (res.factsExpired || res.obsArchived) {
            console.log(`[memory-cron] user ${u.id.slice(0, 8)} decay: ${res.factsExpired} facts expired, ${res.obsArchived} obs archived`);
          }
        } catch (err) {
          console.warn(`[memory-cron] decay user ${u.id}: ${(err as any)?.message?.slice(0, 80)}`);
        }
      }
    } catch (e) {
      console.warn('[memory-cron] decay failed:', (e as any)?.message);
    }
  }, SEVENTY_TWO_HOURS);
  timers.push(decayTimer);
}

export function stopMemoryCron() {
  for (const t of timers) clearInterval(t);
  timers = [];
}
