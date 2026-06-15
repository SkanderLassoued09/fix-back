import { GraphQLError } from 'graphql';
import { STATUS_DI } from '../di.status';

/**
 * M1 — centralized DI status-transition guard.
 *
 * `ALLOWED_TRANSITIONS[target]` = the source statuses a DI may legally be in to
 * move INTO `target`. A mutation that would jump the pipeline (e.g. CREATED →
 * FINISHED) is refused with a clean BAD_REQUEST *before any write*, instead of
 * silently mutating (and 500-ing downstream on the missing Stat).
 *
 * Source lists are derived from the documented workflow sequence + the existing
 * `DI_TRANSITIONS` map:
 *   PENDING1 → DIAGNOSTIC → INDIAGNOSTIC → PENDING2 → PRICING → NEGOTIATION1
 *   → PENDING3 → REPARATION → INREPARATION → FINISHED
 * (plus the documented branches: magasin estimation, negotiation2, pauses).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  [STATUS_DI.Pending1.status]: [STATUS_DI.Created.status],
  [STATUS_DI.Diagnostic.status]: [STATUS_DI.Pending1.status],
  [STATUS_DI.InDiagnostic.status]: [
    STATUS_DI.Diagnostic.status,
    STATUS_DI.DiagnosticInPause.status,
    STATUS_DI.Pending1.status,
  ],
  [STATUS_DI.DiagnosticInPause.status]: [
    STATUS_DI.Diagnostic.status,
    STATUS_DI.InDiagnostic.status,
  ],
  [STATUS_DI.MagasinEstimation.status]: [STATUS_DI.InDiagnostic.status],
  [STATUS_DI.InMagasin.status]: [
    STATUS_DI.MagasinEstimation.status,
    STATUS_DI.InDiagnostic.status,
    // Post-negotiation: a repairable DI that needs spare parts is sent to the
    // magasin to source them (`nego1nego2_InMagasin` flow) before repair.
    STATUS_DI.Negotiation1.status,
    STATUS_DI.Negotiation2.status,
  ],
  [STATUS_DI.Pending2.status]: [
    STATUS_DI.InMagasin.status,
    STATUS_DI.InDiagnostic.status,
    STATUS_DI.MagasinEstimation.status,
  ],
  [STATUS_DI.Pricing.status]: [STATUS_DI.Pending2.status],
  [STATUS_DI.Negotiation1.status]: [
    STATUS_DI.Pricing.status,
    STATUS_DI.Annuler.status,
  ],
  [STATUS_DI.Negotiation2.status]: [STATUS_DI.Negotiation1.status],
  [STATUS_DI.Pending3.status]: [
    STATUS_DI.Negotiation1.status,
    STATUS_DI.Negotiation2.status,
  ],
  [STATUS_DI.Reparation.status]: [STATUS_DI.Pending3.status],
  [STATUS_DI.InReparation.status]: [
    STATUS_DI.Reparation.status,
    STATUS_DI.ReparationInPause.status,
    STATUS_DI.Pending3.status,
  ],
  [STATUS_DI.ReparationInPause.status]: [
    STATUS_DI.Reparation.status,
    STATUS_DI.InReparation.status,
  ],
  [STATUS_DI.Finished.status]: [
    STATUS_DI.InReparation.status,
    STATUS_DI.Reparation.status,
    // Non-repairable DI: finished right after pricing/negotiation, no repair.
    STATUS_DI.Negotiation1.status,
    STATUS_DI.Negotiation2.status,
  ],
};

/**
 * Re-processing sources. A DI sent back (retour) or cancelled (annuler) legally
 * re-enters the pipeline from these states, so they bypass the forward whitelist
 * — the guard targets *forward pipeline skips* (the M1 bug), not return flows.
 */
const REENTRY_SOURCES: readonly string[] = [
  STATUS_DI.Retour1.status,
  STATUS_DI.Retour2.status,
  STATUS_DI.Retour3.status,
  STATUS_DI.Annuler.status,
];

/**
 * Throws a clean BAD_REQUEST `GraphQLError` if moving from `currentStatus` into
 * `targetStatus` is not a legal workflow transition. No-ops (allows) when:
 *   - the target isn't a guarded pipeline status,
 *   - it's an idempotent re-apply (current === target),
 *   - the DI is in a retour/annuler re-entry state.
 */
export function assertDiTransition(
  currentStatus: string | null | undefined,
  targetStatus: string,
): void {
  const allowed = ALLOWED_TRANSITIONS[targetStatus];
  if (!allowed) return; // target not part of the guarded pipeline
  if (currentStatus === targetStatus) return; // idempotent re-apply
  if (currentStatus && REENTRY_SOURCES.includes(currentStatus)) return;
  if (!currentStatus || !allowed.includes(currentStatus)) {
    throw new GraphQLError(
      `Transition non autorisée: ${currentStatus ?? 'INCONNU'} → ${targetStatus}.`,
      {
        extensions: {
          code: 'BAD_REQUEST',
          currentStatus: currentStatus ?? null,
          targetStatus,
        },
      },
    );
  }
}
