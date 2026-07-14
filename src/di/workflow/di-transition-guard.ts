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
 * Source lists are derived from the REAL workflow — every mutation that targets
 * a status and the source states it is legitimately fired from — NOT only the
 * idealized linear sequence:
 *   PENDING1 → DIAGNOSTIC → INDIAGNOSTIC → PENDING2 → PRICING → NEGOTIATION1
 *   → PENDING3 → REPARATION → INREPARATION → FINISHED
 * A target can have MULTIPLE legitimate sources (e.g. PENDING3 is reached both
 * directly from negotiation and from INMAGASIN after the magasin sources spare
 * parts). Seeding the table from the linear sequence alone dropped those real
 * branches and produced false BAD_REQUESTs — the arcs below are reconciled
 * against the actual mutations (di.service.ts) and the proven UI flows.
 *
 * `_Pause` rule. A DI in a `*_Pause` state is functionally equivalent to its
 * active sibling for the purpose of FORWARD transitions: a tech who paused mid-
 * diagnostic and then sends the DI to the magasin must not be refused just
 * because the row sits in `DIAGNOSTIC_Pause` rather than `INDIAGNOSTIC`. The
 * pairs are:
 *   - `INDIAGNOSTIC` ↔ `DIAGNOSTIC_Pause` — same exits (MagasinEstimation,
 *     InMagasin, Pending2, …).
 *   - `INREPARATION` ↔ `REPARATION_Pause` — same exits (Finished, etc.).
 * Earlier the table only listed the active source, so any forward move from a
 * paused DI was refused. The `_Pause` entries below mirror their active sibling
 * verbatim. This neither opens a new arc nor weakens any guard — it just
 * completes the equivalence class.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  [STATUS_DI.Pending1.status]: [
    STATUS_DI.Created.status,
    // « Renvoyer au diagnostic » — the admin, while pricing a (typically
    // non-repairable) DI, can bounce it back to the coordinator so a
    // technician is re-assigned for a fresh diagnostic. PRICING → PENDING1.
    STATUS_DI.Pricing.status,
  ],
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
  [STATUS_DI.MagasinEstimation.status]: [
    STATUS_DI.InDiagnostic.status,
    // `_Pause` rule: a tech who paused mid-diagnostic must still be allowed to
    // route the DI to the magasin estimation. This was the original M1 false
    // positive (`changeStatusMagasinEstimation` refused with
    // `DIAGNOSTIC_Pause → MagasinEstimation`).
    STATUS_DI.DiagnosticInPause.status,
  ],
  [STATUS_DI.InMagasin.status]: [
    STATUS_DI.MagasinEstimation.status,
    STATUS_DI.InDiagnostic.status,
    // `_Pause` rule: mirror of InDiagnostic — same exits while paused.
    STATUS_DI.DiagnosticInPause.status,
    // Post-negotiation: a repairable DI that needs spare parts is sent to the
    // magasin to source them (`nego1nego2_InMagasin` flow) before repair.
    STATUS_DI.Negotiation1.status,
    STATUS_DI.Negotiation2.status,
  ],
  [STATUS_DI.Pending2.status]: [
    STATUS_DI.InMagasin.status,
    STATUS_DI.InDiagnostic.status,
    // `_Pause` rule: mirror of InDiagnostic.
    STATUS_DI.DiagnosticInPause.status,
    STATUS_DI.MagasinEstimation.status,
  ],
  [STATUS_DI.Pricing.status]: [STATUS_DI.Pending2.status],
  [STATUS_DI.Negotiation1.status]: [
    STATUS_DI.Pricing.status,
    STATUS_DI.Annuler.status,
  ],
  [STATUS_DI.Negotiation2.status]: [STATUS_DI.Negotiation1.status],
  [STATUS_DI.Pending3.status]: [
    // B1 — negotiation done, no spare parts needed → straight to repair
    // (managerAdminManager_Pending3 + the changeStatusPending3 "!contain_pdr"
    // branch in the negotiation-confirm modal).
    STATUS_DI.Negotiation1.status,
    STATUS_DI.Negotiation2.status,
    // B3 — negotiation done WITH spare parts: the DI is routed to the magasin
    // (INMAGASIN) to source them, then the magasin's "Fin liste composants"
    // (changeStatusPending3) sends it back to the coordinator for repair.
    // This real branch was absent from the linear sequence the table was
    // seeded from, which is why INMAGASIN → PENDING3 was wrongly refused.
    STATUS_DI.InMagasin.status,
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
    // `_Pause` rule: a tech can finish a repair from the paused state directly
    // (UI flow: pause repair → click "Fin réparation"). Without this entry the
    // finish mutation refuses REPARATION_Pause → FINISHED.
    STATUS_DI.ReparationInPause.status,
    STATUS_DI.Reparation.status,
    // Non-repairable DI: finished right after pricing/negotiation, no repair.
    STATUS_DI.Negotiation1.status,
    STATUS_DI.Negotiation2.status,
    // Non-repairable shortcut from diagnostic: when the tech marks the DI as
    // `can_be_repaired: false` during diagnostic, the modal's "Terminer (non
    // réparable)" action moves it straight to FINISHED — no magasin, no
    // pricing, no repair. Allowed from the active diagnostic state AND its
    // paused sibling (same `_Pause` equivalence rule applied elsewhere).
    STATUS_DI.Diagnostic.status,
    STATUS_DI.InDiagnostic.status,
    STATUS_DI.DiagnosticInPause.status,
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
