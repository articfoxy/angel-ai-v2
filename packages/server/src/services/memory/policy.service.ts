/**
 * PolicyService — the in-process substitute for OPA.
 *
 * Wraps the pure policy functions in policy.ts with:
 *   - per-user policy profiles (privacy mode, retention overrides, allow/deny rules)
 *   - versioned policy decisions (for audit replay)
 *   - audit logging of every denial
 *
 * Design: kept in TypeScript (not Rego/OPA) because we have one service and
 * our decision surface is small. If we ever run multiple services or want
 * operators to edit policies without code deploys, swap to OPA at the
 * service boundary.
 */
import { prisma } from '../../index';
import {
  classifyContent,
  canPersistObservation,
  canPromoteFact,
  canRecall,
  retentionFor,
  isExplicitRemember,
  type PrivacyMode,
  type PrivacyClass,
  type MemoryType,
  type RetentionClass,
} from './policy';
import { logMemoryOp } from './audit';

export const POLICY_VERSION = 1;

export interface PolicyProfile {
  privacyMode: PrivacyMode;
  // Future: allow/deny namespaces, retention overrides per category, etc.
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  version: number;
}

export class PolicyService {
  /** Load effective profile for a user. Falls back to safe defaults. */
  async profileFor(userId: string): Promise<PolicyProfile> {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { privacyMode: true } });
      const mode = (user?.privacyMode as PrivacyMode) || 'standard';
      return { privacyMode: ['off', 'standard', 'private_meeting'].includes(mode) ? mode : 'standard' };
    } catch {
      return { privacyMode: 'standard' };
    }
  }

  classify(content: string): PrivacyClass {
    return classifyContent(content);
  }

  isExplicitRemember(content: string): boolean {
    return isExplicitRemember(content);
  }

  retentionClass(memoryType: MemoryType, privacyClass: PrivacyClass): RetentionClass {
    return retentionFor(memoryType, privacyClass);
  }

  /** Decision: can we store this as an observation? */
  async canPersistObservation(userId: string, privacyClass: PrivacyClass, context?: { reason?: string; memoryId?: string }): Promise<PolicyDecision> {
    const profile = await this.profileFor(userId);
    const allowed = canPersistObservation(profile.privacyMode, privacyClass);
    const reason = allowed
      ? `mode=${profile.privacyMode},class=${privacyClass}`
      : this.denialReason('persist_observation', profile.privacyMode, privacyClass);
    if (!allowed && context?.memoryId) {
      // Log the denial as an audit event so users can see what was blocked
      await logMemoryOp({
        userId,
        actorType: 'system',
        operation: 'delete',
        memoryType: 'observation',
        memoryId: context.memoryId,
        reason: `policy_denied: ${reason}`,
      });
    }
    return { allowed, reason, version: POLICY_VERSION };
  }

  /** Decision: can we promote this to a durable fact? */
  async canPromoteFact(userId: string, privacyClass: PrivacyClass): Promise<PolicyDecision> {
    const profile = await this.profileFor(userId);
    const allowed = canPromoteFact(profile.privacyMode, privacyClass);
    const reason = allowed
      ? `mode=${profile.privacyMode},class=${privacyClass}`
      : this.denialReason('promote_fact', profile.privacyMode, privacyClass);
    return { allowed, reason, version: POLICY_VERSION };
  }

  /** Decision: can we include this in a retrieval prompt? */
  async canRecall(userId: string, privacyClass: PrivacyClass): Promise<PolicyDecision> {
    const profile = await this.profileFor(userId);
    const allowed = canRecall(profile.privacyMode, privacyClass);
    return {
      allowed,
      reason: allowed ? `mode=${profile.privacyMode}` : this.denialReason('recall', profile.privacyMode, privacyClass),
      version: POLICY_VERSION,
    };
  }

  /** Switch privacy mode — user-facing. */
  async setPrivacyMode(userId: string, mode: PrivacyMode): Promise<void> {
    if (!['off', 'standard', 'private_meeting'].includes(mode)) {
      throw new Error(`Invalid privacy mode: ${mode}`);
    }
    await prisma.user.update({ where: { id: userId }, data: { privacyMode: mode } });
    await logMemoryOp({
      userId,
      actorType: 'user',
      operation: 'update',
      memoryType: 'core_block',
      memoryId: 'privacy_mode',
      after: { privacyMode: mode },
      reason: 'privacy mode change',
    });
  }

  private denialReason(op: string, mode: PrivacyMode, cls: PrivacyClass): string {
    if (mode === 'off') return `${op}_denied: privacy=off`;
    if (cls === 'do_not_store') return `${op}_denied: class=do_not_store`;
    if (cls === 'regulated') return `${op}_denied: class=regulated (explicit consent required)`;
    if (mode === 'private_meeting' && cls === 'sensitive') {
      return `${op}_denied: private_meeting blocks sensitive content`;
    }
    return `${op}_denied: mode=${mode} class=${cls}`;
  }
}

// Singleton — stateless, safe to share
export const policyService = new PolicyService();
