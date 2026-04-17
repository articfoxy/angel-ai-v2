/**
 * Memory REST API (Angel Memory OS v2).
 *
 * Endpoints:
 *   GET    /core                       — list core blocks
 *   PATCH  /core/:label                — update a core block
 *   GET    /facts                      — list active facts
 *   DELETE /facts/:id                  — forget a fact
 *   GET    /episodes                   — list episodes
 *   DELETE /episodes/:id               — archive an episode
 *   GET    /procedures                 — list procedures
 *   POST   /procedures/:id/approve     — promote candidate to active
 *   DELETE /procedures/:id             — deprecate
 *   GET    /reflections                — list reflections
 *   GET    /entities                   — list entities
 *   POST   /forget                     — forget by {entity?, dateFrom?, dateTo?, modality?}
 *   GET    /explain/:responseId        — which memories drove a whisper
 *   GET    /audit                      — memory audit log
 *   POST   /privacy                    — switch privacy mode
 */
import { Router, Response } from 'express';
import { prisma } from '../index';
import { AuthRequest } from '../middleware/auth';
import { CoreBlocksService } from '../services/memory/core-blocks.service';
import { FactsService } from '../services/memory/facts.service';
import { EpisodeService } from '../services/memory/episode.service';
import { ProcedureService } from '../services/memory/procedure.service';

export const memoryRouter = Router();

const coreBlocks = new CoreBlocksService();
const facts = new FactsService();
const episodes = new EpisodeService();
const procedures = new ProcedureService();

// ─── Core blocks ────────────────────────────────────────────────────────────

memoryRouter.get('/core', async (req: AuthRequest, res: Response) => {
  try {
    const blocks = await coreBlocks.getAll(req.userId!);
    res.json({ success: true, data: blocks });
  } catch (err: any) {
    console.error('[memory/core] failed:', err?.message);
    res.status(500).json({ error: 'Failed to fetch core blocks', detail: err?.message?.slice(0, 200) });
  }
});

memoryRouter.patch('/core/:label', async (req: AuthRequest, res: Response) => {
  try {
    const label = String(req.params.label);
    const { value } = req.body as { value: string };
    if (typeof value !== 'string') return res.status(400).json({ error: 'value must be string' });
    const updated = await coreBlocks.update(req.userId!, label, value, 'user');
    if (!updated) return res.status(404).json({ error: 'Block not found or read-only' });
    res.json({ success: true, data: updated });
  } catch {
    res.status(500).json({ error: 'Failed to update core block' });
  }
});

// ─── Facts (Layer E) ────────────────────────────────────────────────────────

memoryRouter.get('/facts', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit as string) || 50);
    const status = (req.query.status as string) || 'active';
    const statuses = status === 'all' ? ['active', 'candidate'] : [status];
    const rows = await prisma.fact.findMany({
      where: { userId: req.userId, status: { in: statuses }, validTo: null },
      orderBy: { freshnessAt: 'desc' },
      take: limit,
      select: {
        id: true, content: true, subjectName: true, predicate: true, objectValue: true,
        confidence: true, importance: true, status: true, freshnessAt: true, createdAt: true,
        validFrom: true, validTo: true, tags: true, accessCount: true, privacyClass: true,
        sourceEpisodeIds: true, sourceObservationIds: true,
      },
    });
    res.json({ success: true, data: rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch facts' });
  }
});

memoryRouter.delete('/facts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const ok = await facts.forget(req.userId!, String(req.params.id), 'user', 'user-initiated');
    if (!ok) return res.status(404).json({ error: 'Fact not found' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to forget fact' });
  }
});

// ─── Episodes (Layer D) ─────────────────────────────────────────────────────

memoryRouter.get('/episodes', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit as string) || 50);
    const rows = await episodes.list(req.userId!, { limit });
    res.json({ success: true, data: rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch episodes' });
  }
});

memoryRouter.delete('/episodes/:id', async (req: AuthRequest, res: Response) => {
  try {
    const ok = await episodes.forget(req.userId!, String(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Episode not found' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to archive episode' });
  }
});

// ─── Procedures (Layer F) ───────────────────────────────────────────────────

memoryRouter.get('/procedures', async (req: AuthRequest, res: Response) => {
  try {
    const status = (req.query.status as string) || undefined;
    const rows = await procedures.list(req.userId!, status);
    res.json({ success: true, data: rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch procedures' });
  }
});

memoryRouter.post('/procedures/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const ok = await procedures.approve(req.userId!, String(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Procedure not found' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to approve procedure' });
  }
});

memoryRouter.delete('/procedures/:id', async (req: AuthRequest, res: Response) => {
  try {
    const ok = await procedures.deprecate(req.userId!, String(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Procedure not found' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to deprecate procedure' });
  }
});

// ─── Reflections (Layer G) ──────────────────────────────────────────────────

memoryRouter.get('/reflections', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const rows = await prisma.reflection.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, summary: true, themes: true, importance: true, confidence: true,
        timeWindowStart: true, timeWindowEnd: true, triggerKind: true, createdAt: true,
        supportingEpisodeIds: true, supportingFactIds: true,
      },
    });
    res.json({ success: true, data: rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch reflections' });
  }
});

// ─── Entities ───────────────────────────────────────────────────────────────

memoryRouter.get('/entities', async (req: AuthRequest, res: Response) => {
  try {
    const type = req.query.type as string | undefined;
    const rows = await prisma.entity.findMany({
      where: { userId: req.userId, ...(type ? { entityType: type } : {}) },
      orderBy: { updatedAt: 'desc' },
    });
    res.json({ success: true, data: rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch entities' });
  }
});

// ─── Forget API (PRD §22.6) ─────────────────────────────────────────────────

memoryRouter.post('/forget', async (req: AuthRequest, res: Response) => {
  try {
    const { entity, dateFrom, dateTo, modality, factId, episodeId } = req.body;
    let count = 0;

    if (factId) {
      const ok = await facts.forget(req.userId!, factId, 'user');
      count += ok ? 1 : 0;
    }
    if (episodeId) {
      const ok = await episodes.forget(req.userId!, episodeId);
      count += ok ? 1 : 0;
    }
    if (entity) {
      count += await facts.forgetBySubject(req.userId!, entity);
    }
    if (dateFrom && dateTo) {
      const from = new Date(dateFrom);
      const to = new Date(dateTo);
      count += await facts.forgetByDateRange(req.userId!, from, to);
      count += await episodes.forgetByDateRange(req.userId!, from, to);
    }
    if (modality) {
      // Observations only (episodes span mixed modalities)
      const obsRes = await prisma.observation.deleteMany({
        where: { userId: req.userId, modality },
      });
      count += obsRes.count;
    }
    res.json({ success: true, forgotten: count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to forget: ' + ((err as any)?.message || 'unknown') });
  }
});

// ─── Explain API (PRD §22.5) ────────────────────────────────────────────────

memoryRouter.get('/explain/:responseId', async (req: AuthRequest, res: Response) => {
  try {
    const audit = await prisma.retrievalAudit.findFirst({
      where: { userId: req.userId, responseId: String(req.params.responseId) },
      orderBy: { createdAt: 'desc' },
    });
    if (!audit) return res.status(404).json({ error: 'No audit record for that response' });
    // Hydrate the used memory ids
    const used = audit.usedMemoryIds as any;
    const [factRows, episodeRows, reflectionRows, procedureRows] = await Promise.all([
      prisma.fact.findMany({ where: { id: { in: used?.facts || [] } } }),
      prisma.episode.findMany({ where: { id: { in: used?.episodes || [] } } }),
      prisma.reflection.findMany({ where: { id: { in: used?.reflections || [] } } }),
      prisma.procedure.findMany({ where: { id: { in: used?.procedures || [] } } }),
    ]);
    res.json({
      success: true,
      data: {
        queryText: audit.queryText,
        reasonCodes: audit.reasonCodes,
        latencyMs: audit.latencyMs,
        createdAt: audit.createdAt,
        used: { facts: factRows, episodes: episodeRows, reflections: reflectionRows, procedures: procedureRows },
      },
    });
  } catch {
    res.status(500).json({ error: 'Failed to explain' });
  }
});

// ─── Audit log ──────────────────────────────────────────────────────────────

memoryRouter.get('/audit', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit as string) || 50);
    const rows = await prisma.memoryAuditLog.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ success: true, data: rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// ─── Privacy mode ───────────────────────────────────────────────────────────

memoryRouter.post('/privacy', async (req: AuthRequest, res: Response) => {
  try {
    const { mode } = req.body as { mode: 'off' | 'standard' | 'private_meeting' };
    const { policyService } = await import('../services/memory/policy.service');
    await policyService.setPrivacyMode(req.userId!, mode);
    res.json({ success: true, mode });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to update privacy mode' });
  }
});

// Durable job dispatch (admin actions)
memoryRouter.post('/jobs/re_embed', async (req: AuthRequest, res: Response) => {
  try {
    const { enqueue } = await import('../services/jobs');
    await enqueue('memory.re_embed_facts', { userId: req.userId }, { priority: 5 });
    res.json({ success: true, queued: 'memory.re_embed_facts' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to enqueue job' });
  }
});

memoryRouter.post('/jobs/forget', async (req: AuthRequest, res: Response) => {
  try {
    const { enqueue } = await import('../services/jobs');
    await enqueue('memory.forget_workflow', {
      userId: req.userId,
      entity: req.body?.entity,
      dateFrom: req.body?.dateFrom,
      dateTo: req.body?.dateTo,
      modality: req.body?.modality,
      reason: req.body?.reason || 'user',
    }, { priority: 10 });
    res.json({ success: true, queued: 'memory.forget_workflow' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to enqueue forget job' });
  }
});

memoryRouter.get('/privacy', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { privacyMode: true } });
    res.json({ success: true, mode: user?.privacyMode || 'standard' });
  } catch {
    res.status(500).json({ error: 'Failed to fetch privacy mode' });
  }
});
