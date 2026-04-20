/**
 * ContradictionDetector — Phase C.
 *
 * Fires on every new commitment extraction. If the candidate conflicts with
 * an existing open commitment (same from+to, overlapping due dates, similar
 * description), proposes a warning whisper through the orchestrator.
 */
import { CommitmentService, type CommitmentInput } from '../memory/commitment.service';
import { responseOrchestrator } from './orchestrator.service';

export class ContradictionDetector {
  private commitments: CommitmentService;

  constructor() {
    this.commitments = new CommitmentService();
  }

  async checkAndAlert(
    userId: string,
    newCommitmentId: string,
    newCommitment: CommitmentInput,
  ): Promise<boolean> {
    const conflicting = await this.commitments.findContradicting(userId, newCommitment);
    // Filter out the new commitment itself (findContradicting might return it if
    // there's a timing race)
    const others = conflicting.filter((c) => c.id !== newCommitmentId);
    if (others.length === 0) return false;

    // Pick the most relevant conflict: same fromName→toName AND closest due date
    const best = others[0];
    const oldDate = best.dueDate ? fmtDate(best.dueDate) : 'earlier';
    const newDate = newCommitment.dueDate ? fmtDate(newCommitment.dueDate) : 'now';

    await responseOrchestrator.propose({
      userId,
      kind: 'contradiction',
      importance: 7,
      content: `Heads up: you already committed to "${best.description}" for ${oldDate}. This new one says ${newDate}. Want both tracked?`,
      dedupKey: `contradict-${best.id}-${newCommitmentId}`,
      data: {
        existingCommitmentId: best.id,
        newCommitmentId,
      },
    });

    // Link them so UI can show the conflict
    await this.commitments.markContradiction(newCommitmentId, [best.id]);
    return true;
  }
}

function fmtDate(d: Date): string {
  const days = Math.round((d.getTime() - Date.now()) / (24 * 3_600_000));
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0 && days < 7) return `in ${days}d`;
  if (days < 0) return `${Math.abs(days)}d ago`;
  return d.toLocaleDateString();
}
