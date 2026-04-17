/**
 * Memory policy engine (PRD §19 — v1 lightweight substitute for OPA).
 *
 * All decisions funnel through pure functions: can we store this observation?
 * Can we durably remember this fact? Is this content sensitive? Retention
 * class? Sensitivity is re-checked at retrieval time too.
 */

export type PrivacyMode = 'off' | 'standard' | 'private_meeting';
export type PrivacyClass = 'public' | 'private' | 'sensitive' | 'regulated' | 'do_not_store';
export type MemoryType = 'observation' | 'fact' | 'episode' | 'reflection' | 'procedure' | 'core_block';
export type RetentionClass = 'short' | 'medium' | 'long' | 'permanent';

// Heuristic patterns for sensitive content — kept conservative; LLM judge
// overrides with finer classification when available.
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(?:ssn|social\s*security|passport\s*number|tax\s*id|national\s*id)\b/i,
  /\b\d{3}-?\d{2}-?\d{4}\b/, // US SSN format
  /\b(?:credit\s*card|card\s*number|cvv|cvc)\b/i,
  /\b4\d{3}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, // Visa-ish
  /\b(?:bank\s*account|routing\s*number|iban)\b/i,
  /\b(?:medical|prescription|diagnosis|hiv|depression|anxiety|therapist)\b/i,
  /\b(?:abortion|affair|mistress|cheating|divorce\s*plans)\b/i,
  /password\s*[:=]\s*\S+/i,
  /\bapi[_\s-]?key\s*[:=]\s*\S+/i,
];

const REGULATED_PATTERNS: RegExp[] = [
  /\b(?:hipaa|phi|protected\s*health)\b/i,
  /\b(?:pci|cardholder\s*data)\b/i,
  /\b(?:gdpr|personal\s*data\s*request)\b/i,
];

/** Classify content into a privacy class via regex heuristics. LLM judge can override. */
export function classifyContent(content: string): PrivacyClass {
  if (REGULATED_PATTERNS.some((r) => r.test(content))) return 'regulated';
  if (SENSITIVE_PATTERNS.some((r) => r.test(content))) return 'sensitive';
  return 'public';
}

/** Can we persist this observation durably? */
export function canPersistObservation(privacyMode: PrivacyMode, privacyClass: PrivacyClass): boolean {
  if (privacyMode === 'off') return false;
  if (privacyClass === 'do_not_store') return false;
  if (privacyMode === 'private_meeting' && (privacyClass === 'sensitive' || privacyClass === 'regulated')) return false;
  return true;
}

/** Can we promote this to a durable fact? Stricter than observation persistence. */
export function canPromoteFact(privacyMode: PrivacyMode, privacyClass: PrivacyClass): boolean {
  if (privacyMode !== 'standard') return false;
  if (privacyClass === 'regulated' || privacyClass === 'do_not_store') return false;
  return true;
}

/** Can we include this memory in the retrieval context for the LLM? */
export function canRecall(privacyMode: PrivacyMode, privacyClass: PrivacyClass): boolean {
  if (privacyMode === 'off') return false;
  if (privacyClass === 'do_not_store') return false;
  if (privacyMode === 'private_meeting' && privacyClass === 'sensitive') return false;
  return true;
}

/** Retention class for a memory type + privacy class. Cold archive TTLs not
 *  enforced here — the decay job applies the policy. */
export function retentionFor(type: MemoryType, privacyClass: PrivacyClass): RetentionClass {
  if (privacyClass === 'do_not_store') return 'short';
  if (privacyClass === 'regulated') return 'short'; // never keep long without explicit user consent
  if (privacyClass === 'sensitive') return 'medium';
  if (type === 'observation') return 'medium';
  if (type === 'fact' || type === 'procedure' || type === 'core_block') return 'long';
  if (type === 'episode' || type === 'reflection') return 'medium';
  return 'medium';
}

/** Convert retention class to a delete-after duration (ms). */
export function retentionTTL(cls: RetentionClass): number | null {
  switch (cls) {
    case 'short':     return 7 * 24 * 60 * 60 * 1000;       // 7 days
    case 'medium':    return 90 * 24 * 60 * 60 * 1000;      // 90 days
    case 'long':      return 2 * 365 * 24 * 60 * 60 * 1000; // 2 years
    case 'permanent': return null;
  }
}

/** Quick check: does the model have an LLM judge available for this user? */
export function hasLLMAccess(openaiKey: string | null | undefined): boolean {
  return !!(openaiKey && openaiKey.length > 10);
}

/**
 * Heuristic for "explicit remember" detection — patterns that mean the user
 * is asking Angel to persist something specifically. These bypass multi-signal
 * promotion rules and go straight to fact candidate status.
 */
export function isExplicitRemember(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(?:remember\s+(?:this|that)|don'?t\s+forget|note\s+that|from\s+now\s+on|for\s+the\s+record|jot\s+down)\b/.test(lower);
}
