/**
 * MemoryJudgeService — the LLM that decides what observations become what.
 *
 * Inputs:
 *   - batch of unprocessed observations
 *   - current working state
 *   - recent episode summaries (for context)
 *   - current user profile (from core_blocks)
 *   - top-K semantically-similar existing facts (for fact ops)
 *
 * Outputs:
 *   {
 *     working_state_delta: { key: value, ... },
 *     episode?: { title, summary, importance, confidence },
 *     fact_ops: [{ op: ADD|UPDATE|SUPERSEDE|NOOP, ... }],
 *     procedure_candidate?: { trigger_signature, policy_text, ... },
 *     entities?: [{ name, type, aliases }],
 *     core_block_updates?: { label: append_text }
 *   }
 *
 * Runs as part of:
 *   - session close (flush all unprocessed observations)
 *   - mode switch (flush partial, start new episode boundary)
 *   - importance burst (adaptive trigger)
 *   - periodic (every N observations or T seconds)
 */
import OpenAI from 'openai';
import { prisma } from '../../index';
import { ObservationService } from './observation.service';
import { FactsService, type FactRecord } from './facts.service';
import { EpisodeService } from './episode.service';
import { CoreBlocksService } from './core-blocks.service';
import { WorkingStateService } from './working-state.service';
import type { PrivacyMode } from './policy';
import { isExplicitRemember } from './policy';
import { withSpan } from '../../telemetry';

const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gpt-4o-mini';

interface JudgeFactOp {
  op: 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'NOOP';
  fact_id?: string; // required for UPDATE / SUPERSEDE
  subject_name?: string;
  subject_type?: 'user' | 'person' | 'org' | 'topic' | 'system';
  predicate?: string;
  object_type?: 'string' | 'number' | 'boolean' | 'date' | 'entity' | 'json';
  object_value?: any;
  content?: string;
  confidence?: number;
  importance?: number;
  namespace?: string;
  tags?: string[];
  reason?: string;
}

interface JudgeOutput {
  working_state_delta?: Record<string, any>;
  episode?: {
    title: string;
    summary: string;
    importance: number;
    confidence: number;
    actors?: string[];
    salience?: any;
  } | null;
  fact_ops?: JudgeFactOp[];
  procedure_candidate?: {
    trigger_signature: string;
    policy_text: string;
    category: string;
    examples?: any[];
    confidence?: number;
  } | null;
  entities?: Array<{ name: string; type: string; aliases?: string[] }>;
  core_block_updates?: Record<string, string>;
  reasoning?: string;
}

export interface JudgeTriggerReason {
  kind: 'session_end' | 'mode_switch' | 'importance_burst' | 'periodic' | 'manual';
  sessionId?: string | null;
  modeFrom?: string;
  modeTo?: string;
}

export class MemoryJudgeService {
  private openai: OpenAI;
  private obs: ObservationService;
  private facts: FactsService;
  private episodes: EpisodeService;
  private coreBlocks: CoreBlocksService;
  private workingState: WorkingStateService;

  constructor(private apiKey?: string) {
    this.openai = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
    this.obs = new ObservationService(apiKey);
    this.facts = new FactsService(apiKey);
    this.episodes = new EpisodeService(apiKey);
    this.coreBlocks = new CoreBlocksService();
    this.workingState = new WorkingStateService();
  }

  /**
   * Main entry point. Consumes unprocessed observations for the user/session,
   * produces episode + fact ops + state deltas. Marks observations processed.
   * Returns a summary of what changed.
   */
  async run(params: {
    userId: string;
    sessionId?: string | null;
    trigger: JudgeTriggerReason;
    privacyMode?: PrivacyMode;
  }): Promise<{
    observationsProcessed: number;
    episodeCreated: string | null;
    factsAdded: number;
    factsUpdated: number;
    factsSuperseded: number;
    proceduresProposed: number;
  }> {
    return withSpan('memory.judge.run', async (span) => {
      span?.setAttribute('memory.trigger', params.trigger.kind);
      span?.setAttribute('memory.user_id', params.userId);
      const result = await this._run(params);
      span?.setAttribute('memory.obs_processed', result.observationsProcessed);
      span?.setAttribute('memory.facts_added', result.factsAdded);
      span?.setAttribute('memory.facts_updated', result.factsUpdated);
      span?.setAttribute('memory.facts_superseded', result.factsSuperseded);
      return result;
    }, { 'memory.layer': 'judge' });
  }

  private async _run(params: {
    userId: string;
    sessionId?: string | null;
    trigger: JudgeTriggerReason;
    privacyMode?: PrivacyMode;
  }): Promise<{
    observationsProcessed: number;
    episodeCreated: string | null;
    factsAdded: number;
    factsUpdated: number;
    factsSuperseded: number;
    proceduresProposed: number;
  }> {
    const { userId, sessionId, trigger } = params;
    const privacyMode = params.privacyMode ?? 'standard';

    // ATOMIC CLAIM — select + mark processed in a single UPDATE...RETURNING so
    // concurrent judge runs (periodic + session_end) cannot pick up the same
    // batch. Any later observations arrive as processed=false and are claimed
    // by the next run.
    //
    // LIMIT dynamically — stop before exceeding ~60k chars of content to keep
    // the LLM input within gpt-4o-mini's 128k context window after prompt overhead.
    const claimed: Array<{
      id: string; observedAt: Date; modality: string; source: string;
      speaker: string | null; content: string; importance: number; payload: any;
      privacyClass: string;
    }> = await prisma.$queryRawUnsafe(
      `UPDATE "Observation"
       SET processed = true
       WHERE id IN (
         SELECT id FROM "Observation"
         WHERE "userId" = $1 AND processed = false
           ${sessionId ? `AND "sessionId" = $2` : ''}
         ORDER BY "observedAt" ASC
         LIMIT 50
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, "observedAt", modality, source, speaker, content, importance, payload, "privacyClass"`,
      ...[userId, ...(sessionId ? [sessionId] : [])],
    );

    if (claimed.length === 0) {
      return { observationsProcessed: 0, episodeCreated: null, factsAdded: 0, factsUpdated: 0, factsSuperseded: 0, proceduresProposed: 0 };
    }
    const observations = claimed;

    // STRICTEST privacy class of the batch — facts derived from ANY sensitive
    // observation inherit that class, so they don't leak into prompts via
    // public-by-default retrieval.
    const rank: Record<string, number> = { public: 0, private: 1, sensitive: 2, regulated: 3, do_not_store: 4 };
    const batchPrivacyClass = observations.reduce(
      (max: string, o: any) => (rank[o.privacyClass] > rank[max] ? o.privacyClass : max),
      'public',
    ) as any;

    // Context for the judge
    const [recentEpisodes, coreBlockText, workingStateText] = await Promise.all([
      this.episodes.list(userId, { limit: 3 }),
      this.coreBlocks.renderForPrompt(userId),
      this.workingState.renderForPrompt(userId, sessionId ?? null),
    ]);

    // For fact ops, we need top-K similar existing facts. We join all
    // observation content and fetch top 10 similar facts as candidates for
    // UPDATE/SUPERSEDE.
    const combined = observations.map((o) => `[${o.speaker || o.source}] ${o.content}`).join('\n');
    const similarFacts = await this.facts.findSimilar(userId, combined, 10);

    // Call the judge
    let output: JudgeOutput;
    try {
      output = await this.callLLM({
        observations,
        recentEpisodes,
        coreBlockText,
        workingStateText,
        similarFacts,
        trigger,
      });
    } catch (err) {
      console.error('[judge] LLM call failed:', (err as any)?.message);
      // Observations already claimed (processed=true). If LLM is down we lose
      // this batch — preferable to infinite reprocessing + duplicate facts.
      return { observationsProcessed: observations.length, episodeCreated: null, factsAdded: 0, factsUpdated: 0, factsSuperseded: 0, proceduresProposed: 0 };
    }

    // Apply outputs
    let episodeCreated: string | null = null;
    if (output.episode && observations.length >= 2) {
      episodeCreated = await this.episodes.create({
        userId,
        sessionId: sessionId ?? null,
        timeStart: observations[0].observedAt,
        timeEnd: observations[observations.length - 1].observedAt,
        title: output.episode.title,
        summary: output.episode.summary,
        importance: output.episode.importance,
        confidence: output.episode.confidence,
        sourceObservationIds: observations.map((o) => o.id),
        actors: output.episode.actors ?? [],
        salience: output.episode.salience ?? null,
      });
    }

    // Apply working state delta
    if (output.working_state_delta) {
      for (const [key, value] of Object.entries(output.working_state_delta)) {
        try {
          await this.workingState.set(userId, sessionId ?? null, key as any, value);
        } catch {}
      }
    }

    // Apply fact ops
    let factsAdded = 0, factsUpdated = 0, factsSuperseded = 0;
    const explicitRememberDetected = observations.some((o) => o.speaker === 'Owner' && isExplicitRemember(o.content));

    for (const op of output.fact_ops ?? []) {
      try {
        if (op.op === 'NOOP') continue;
        const importance = explicitRememberDetected ? Math.max(op.importance ?? 6, 7) : (op.importance ?? 5);

        if (op.op === 'ADD') {
          if (!op.subject_name || !op.predicate || op.object_value === undefined || !op.content) continue;
          // Dangerous predicate / subject guard — prompt-injection defense
          if (isForbiddenFactShape(op)) { continue; }
          const id = await this.facts.add({
            userId,
            namespace: op.namespace ?? 'general',
            subjectType: op.subject_type ?? 'user',
            subjectName: op.subject_name,
            predicate: op.predicate,
            objectType: op.object_type ?? 'string',
            objectValue: op.object_value,
            content: op.content,
            confidence: explicitRememberDetected ? Math.max(op.confidence ?? 0.7, 0.85) : (op.confidence ?? 0.6),
            importance,
            sourceEpisodeIds: episodeCreated ? [episodeCreated] : [],
            sourceObservationIds: observations.map((o) => o.id),
            tags: op.tags,
            privacyClass: batchPrivacyClass,
          }, privacyMode);
          if (id) factsAdded++;
        } else if (op.op === 'UPDATE') {
          if (!op.fact_id) continue;
          const ok = await this.facts.update(userId, op.fact_id, {
            content: op.content,
            objectValue: op.object_value,
            confidence: op.confidence,
            importance: op.importance,
            tags: op.tags,
            sourceEpisodeIds: episodeCreated ? [episodeCreated] : [],
            sourceObservationIds: observations.map((o) => o.id),
          });
          if (ok) factsUpdated++;
        } else if (op.op === 'SUPERSEDE') {
          if (!op.fact_id || !op.subject_name || !op.predicate || op.object_value === undefined || !op.content) continue;
          if (isForbiddenFactShape(op)) { continue; }
          const newId = await this.facts.supersede(userId, op.fact_id, {
            userId,
            namespace: op.namespace ?? 'general',
            subjectType: op.subject_type ?? 'user',
            subjectName: op.subject_name,
            predicate: op.predicate,
            objectType: op.object_type ?? 'string',
            objectValue: op.object_value,
            content: op.content,
            confidence: op.confidence ?? 0.75,
            importance,
            sourceEpisodeIds: episodeCreated ? [episodeCreated] : [],
            sourceObservationIds: observations.map((o) => o.id),
            tags: op.tags,
            privacyClass: batchPrivacyClass,
          }, privacyMode);
          if (newId) factsSuperseded++;
        }
      } catch (err) {
        console.warn('[judge] fact op failed:', (err as any)?.message);
      }
    }

    // Apply core block updates (append-only)
    if (output.core_block_updates) {
      for (const [label, text] of Object.entries(output.core_block_updates)) {
        if (text && typeof text === 'string') {
          await this.coreBlocks.append(userId, label, text, 'llm_judge');
        }
      }
    }

    // Procedure candidate (only create — promotion happens elsewhere)
    let proceduresProposed = 0;
    if (output.procedure_candidate) {
      try {
        await prisma.procedure.create({
          data: {
            userId,
            triggerSignature: output.procedure_candidate.trigger_signature,
            policyText: output.procedure_candidate.policy_text,
            category: output.procedure_candidate.category ?? 'behavior',
            examples: (output.procedure_candidate.examples ?? []) as any,
            confidence: output.procedure_candidate.confidence ?? 0.5,
            sourceEpisodeIds: episodeCreated ? [episodeCreated] : [],
            status: 'candidate',
          },
        });
        proceduresProposed++;
      } catch {}
    }

    // Observations were claimed (processed=true) atomically at the top of _run.
    // No additional mark-processed needed here.

    return {
      observationsProcessed: observations.length,
      episodeCreated,
      factsAdded,
      factsUpdated,
      factsSuperseded,
      proceduresProposed,
    };
  }

  // ─── LLM prompt construction ──────────────────────────────────────────────

  private async callLLM(ctx: {
    observations: any[];
    recentEpisodes: any[];
    coreBlockText: string;
    workingStateText: string;
    similarFacts: FactRecord[];
    trigger: JudgeTriggerReason;
  }): Promise<JudgeOutput> {
    // Truncate observations so total content stays well under model context window.
    // gpt-4o-mini has 128k input tokens ≈ 512k chars. Keep observations under 60k
    // to leave headroom for system prompt, similar_facts, and episodes.
    const MAX_OBS_CHARS = 60_000;
    let totalChars = 0;
    const obsForPrompt: any[] = [];
    for (const o of ctx.observations) {
      const line = `[obs#${obsForPrompt.length} ${o.modality}] ${o.speaker || o.source}: ${String(o.content).slice(0, 800)}`;
      if (totalChars + line.length > MAX_OBS_CHARS) break;
      totalChars += line.length;
      obsForPrompt.push({ ...o, _line: line });
    }
    const observationsText = obsForPrompt.map((o) => o._line).join('\n');

    const similarFactsText = ctx.similarFacts.length > 0
      ? ctx.similarFacts.map((f) => `[fact_id=${f.id} conf=${f.confidence.toFixed(2)} status=${f.status}] ${f.content}`).join('\n')
      : '(none)';

    const recentEpisodesText = ctx.recentEpisodes.length > 0
      ? ctx.recentEpisodes.map((e) => `- ${e.title}: ${e.summary.slice(0, 200)}`).join('\n')
      : '(none)';

    const system = `You are Angel's Memory Judge.

Your job: look at a batch of new observations (transcript chunks, tool results,
scene events) and produce structured outputs that update memory layers.

Context:
- core_memory (user profile, prefs) — do not duplicate facts already here
- working_state — current session's scratchpad
- recent_episodes — the last few summarized interactions
- similar_facts — top-K existing facts semantically close to the new content
- trigger — why this judge call is happening

Produce JSON with these fields:

working_state_delta: updates to the working scratchpad. Keys: current_topic,
open_loops, active_meeting, pending_tool_calls, interruption_mode,
last_confirmed_intent. Only include keys that changed.

episode: if this batch represents a meaningful bounded interaction, produce
a title + summary. Skip if the batch is fragmented / insufficient.

fact_ops: array of operations. For each new concrete claim in the observations,
compare it to similar_facts and pick:
  - ADD: new fact that doesn't exist (provide full fact fields)
  - UPDATE: same fact, refresh confidence or minor detail (provide fact_id + what changed)
  - SUPERSEDE: fact has CHANGED — old value is now wrong (provide fact_id of OLD + full new fact fields)
  - NOOP: fact already recorded, nothing new

Rules for fact_ops:
- Only durable beliefs become facts. Transient state is working_state.
- Explicit "remember this / from now on / don't forget" → ADD with confidence≥0.85.
- Prefer SUPERSEDE over UPDATE when the object_value has genuinely changed.
- predicate should be a verb or relation (prefers, works_at, scheduled_for, likes, said_on, decided_on).
- object_type is the shape of object_value (string/number/boolean/date/entity/json).

procedure_candidate: if the user issued a correction or gave a "from now on"
rule that affects future behavior, propose a procedure. Otherwise null.

entities: only new people/orgs/topics worth resolving. Skip duplicates.

core_block_updates: only for durable things about the USER themselves.
Append small text, don't overwrite. Valid labels: user_profile, mission, comm_style.

reasoning: one or two sentences describing your decisions. For audit.

OUTPUT: Valid JSON, no markdown fences.`;

    const user = `## core_memory
${ctx.coreBlockText || '(empty)'}

## working_state
${ctx.workingStateText || '(empty)'}

## recent_episodes
${recentEpisodesText}

## similar_facts
${similarFactsText}

## new_observations (trigger=${ctx.trigger.kind})
${observationsText}

Now produce the JSON output.`;

    const res = await this.openai.chat.completions.create({
      model: JUDGE_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });
    const text = res.choices[0]?.message?.content || '{}';
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
}

/**
 * Guard against prompt-injection-crafted fact ops. A bystander or adversarial
 * transcript could try to inject facts that the brain then reads back as
 * system state. Block obvious escalation attempts.
 */
function isForbiddenFactShape(op: JudgeFactOp): boolean {
  const subj = (op.subject_name || '').toLowerCase();
  const pred = (op.predicate || '').toLowerCase();
  const subjType = (op.subject_type || '').toLowerCase();
  // Reject facts positioning the system/assistant as subject
  if (['system', 'angel', 'assistant', 'admin', 'root'].includes(subj)) return true;
  if (['system', 'admin'].includes(subjType)) return true;
  // Reject auth/permission-shaped predicates
  if (/\b(admin|auth|sudo|role|permission|password|token|credential|api.?key)\b/.test(pred)) return true;
  return false;
}
