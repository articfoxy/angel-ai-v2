/**
 * CoreBlockService (Layer A) — always-injected named memory blocks.
 *
 * Fixed set of small text blocks that go into the system prompt verbatim
 * every turn. Never retrieved. Versioned. Optionally read-only (safety rules
 * that the LLM judge cannot overwrite).
 *
 * Pattern borrowed from Letta + Claude Code's CLAUDE.md: deterministic
 * injection beats retrieval for identity/preference data.
 */
import { prisma } from '../../index';
import { logMemoryOp } from './audit';

// Default block set — created on first access for a user
const DEFAULT_BLOCKS: Array<{ label: string; value: string; readOnly: boolean; tokenBudget: number }> = [
  { label: 'persona',      value: 'You are Angel — a personal AI whispering into the user\'s ear via AirPods. Concise, helpful, respectful of their time. Never overexplain.', readOnly: false, tokenBudget: 150 },
  { label: 'user_profile', value: '', readOnly: false, tokenBudget: 400 },
  { label: 'safety',       value: 'Never help the user deceive, manipulate, or harm others. Never expose other users\' private data. Refuse requests for illegal activities.', readOnly: true, tokenBudget: 100 },
  { label: 'comm_style',   value: 'Default: terse, information-dense. Match the user\'s energy. Only expand when asked.', readOnly: false, tokenBudget: 80 },
  { label: 'mission',      value: '', readOnly: false, tokenBudget: 150 },
  { label: 'device_env',   value: 'Device: wearable AirPods + iOS app. Audio-first. Text input available. TTS output.', readOnly: false, tokenBudget: 80 },
];

export interface CoreBlockDisplay {
  id: string;
  label: string;
  value: string;
  version: number;
  readOnly: boolean;
  tokenCount: number;
  updatedAt: Date;
}

export class CoreBlocksService {
  /** Ensure default blocks exist for this user. Idempotent. */
  async ensureDefaults(userId: string): Promise<void> {
    for (const b of DEFAULT_BLOCKS) {
      await prisma.coreBlock.upsert({
        where: { userId_label: { userId, label: b.label } },
        create: {
          userId,
          label: b.label,
          value: b.value,
          readOnly: b.readOnly,
          tokenCount: estimateTokens(b.value),
          version: 1,
        },
        update: {}, // don't overwrite existing
      });
    }
  }

  /** Fetch all blocks for a user, ordered for injection. */
  async getAll(userId: string): Promise<CoreBlockDisplay[]> {
    await this.ensureDefaults(userId);
    const blocks = await prisma.coreBlock.findMany({
      where: { userId },
      orderBy: { label: 'asc' },
    });
    return blocks.map((b) => ({
      id: b.id,
      label: b.label,
      value: b.value,
      version: b.version,
      readOnly: b.readOnly,
      tokenCount: b.tokenCount,
      updatedAt: b.updatedAt,
    }));
  }

  /**
   * Render all non-empty blocks into a prompt-ready string. Cheap; called
   * every turn. Budget-bounded per label.
   */
  async renderForPrompt(userId: string): Promise<string> {
    const blocks = await this.getAll(userId);
    const parts: string[] = [];
    for (const b of blocks) {
      if (!b.value.trim()) continue;
      parts.push(`<${b.label}>\n${b.value.trim()}\n</${b.label}>`);
    }
    return parts.length ? `<core_memory>\n${parts.join('\n\n')}\n</core_memory>` : '';
  }

  /** Update a single block's value. Bumps version, writes audit. */
  async update(
    userId: string,
    label: string,
    value: string,
    actor: 'user' | 'llm_judge' | 'system' = 'user',
  ): Promise<CoreBlockDisplay | null> {
    const existing = await prisma.coreBlock.findUnique({
      where: { userId_label: { userId, label } },
    });
    if (!existing) return null;
    if (existing.readOnly && actor !== 'user') return null;

    const updated = await prisma.coreBlock.update({
      where: { id: existing.id },
      data: {
        value: value.slice(0, 4000),
        version: existing.version + 1,
        tokenCount: estimateTokens(value),
      },
    });

    logMemoryOp({
      userId,
      actorType: actor,
      operation: 'update',
      memoryType: 'core_block',
      memoryId: existing.id,
      before: { value: existing.value, version: existing.version },
      after: { value: updated.value, version: updated.version },
    }).catch(() => {});

    return {
      id: updated.id,
      label: updated.label,
      value: updated.value,
      version: updated.version,
      readOnly: updated.readOnly,
      tokenCount: updated.tokenCount,
      updatedAt: updated.updatedAt,
    };
  }

  /** Append text to a block (e.g. for "add to user profile" operations). */
  async append(userId: string, label: string, text: string, actor: 'user' | 'llm_judge' | 'system' = 'llm_judge'): Promise<void> {
    const existing = await prisma.coreBlock.findUnique({ where: { userId_label: { userId, label } } });
    if (!existing || existing.readOnly) return;
    const clean = text.trim();
    if (!clean || existing.value.includes(clean)) return;
    const next = existing.value.trim() ? `${existing.value}\n${clean}` : clean;
    await this.update(userId, label, next, actor);
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
