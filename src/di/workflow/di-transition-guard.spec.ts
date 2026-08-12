import { GraphQLError } from 'graphql';
import { STATUS_DI } from '../di.status';
import {
  ALLOWED_TRANSITIONS,
  assertDiTransition,
} from './di-transition-guard';

/**
 * Regression coverage for the M1 guard. Two responsibilities:
 *   1) `_Pause` equivalence — a DI in `*_Pause` accepts the same forward exits
 *      as its active sibling. The original report (`changeStatusMagasinEstimation`
 *      → "Transition non autorisée: DIAGNOSTIC_Pause → MagasinEstimation") is
 *      locked in below so the next M1 regression can't sneak past CI.
 *   2) Illegal pipeline jumps stay refused — the guard must not slide into a
 *      permissive "allow everything" mode while it gets completed.
 */
describe('assertDiTransition · M1 guard', () => {
  // ── Legal transitions ────────────────────────────────────────────────────

  it('happy path: DIAGNOSTIC → INDIAGNOSTIC is allowed', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.Diagnostic.status,
        STATUS_DI.InDiagnostic.status,
      ),
    ).not.toThrow();
  });

  it('happy path: INDIAGNOSTIC → MagasinEstimation is allowed', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.InDiagnostic.status,
        STATUS_DI.MagasinEstimation.status,
      ),
    ).not.toThrow();
  });

  // ── `_Pause` equivalence (regression: the M1 false positive reported by user) ─

  it('DIAGNOSTIC_Pause → MagasinEstimation is allowed (regression for the M1 false positive)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.DiagnosticInPause.status,
        STATUS_DI.MagasinEstimation.status,
      ),
    ).not.toThrow();
  });

  it('DIAGNOSTIC_Pause → InMagasin is allowed (mirror of INDIAGNOSTIC)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.DiagnosticInPause.status,
        STATUS_DI.InMagasin.status,
      ),
    ).not.toThrow();
  });

  it('DIAGNOSTIC_Pause → Pending2 is allowed (mirror of INDIAGNOSTIC)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.DiagnosticInPause.status,
        STATUS_DI.Pending2.status,
      ),
    ).not.toThrow();
  });

  // status flow v2: a repaired DI (paused or not) can no longer close DIRECTLY —
  // it goes through ATTENTE_BL_FACTURE. The paused finish now targets that wait.
  it('REPARATION_Pause → ATTENTE_BL_FACTURE is allowed (finish from pause, doc gate)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.ReparationInPause.status,
        STATUS_DI.WaitingBl.status,
      ),
    ).not.toThrow();
  });

  // Non-repairable shortcut from diagnostic — the tech marks the DI
  // `can_be_repaired: false` and clicks "Terminer (non réparable)" → straight
  // to FINISHED without magasin/pricing/repair.
  it('DIAGNOSTIC → FINISHED is allowed (non-réparable shortcut)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.Diagnostic.status,
        STATUS_DI.Finished.status,
      ),
    ).not.toThrow();
  });
  it('INDIAGNOSTIC → FINISHED is allowed (non-réparable shortcut)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.InDiagnostic.status,
        STATUS_DI.Finished.status,
      ),
    ).not.toThrow();
  });
  it('DIAGNOSTIC_Pause → FINISHED is allowed (non-réparable shortcut, _Pause mirror)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.DiagnosticInPause.status,
        STATUS_DI.Finished.status,
      ),
    ).not.toThrow();
  });

  // ── Multi-source arcs (negotiation → magasin, INMAGASIN → Pending3) ─────

  it('NEGOTIATION1 → InMagasin is allowed (parts-needed branch)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.WaitingBc.status,
        STATUS_DI.InMagasin.status,
      ),
    ).not.toThrow();
  });

  it('INMAGASIN → Pending3 is allowed (magasin completed parts list — legacy in-flight)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.InMagasin.status,
        STATUS_DI.Pending3.status,
      ),
    ).not.toThrow();
  });

  // ── New CONFIRMATION_COMPOSANTS phase (skip-component-confirmation feature) ─

  it('INMAGASIN → CONFIRMATION_COMPOSANTS is allowed (magasin sends for confirmation)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.InMagasin.status,
        STATUS_DI.ConfirmationComposants.status,
      ),
    ).not.toThrow();
  });

  it('CONFIRMATION_COMPOSANTS → Pending3 is allowed (magasin finalize after confirmation)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.ConfirmationComposants.status,
        STATUS_DI.Pending3.status,
      ),
    ).not.toThrow();
  });

  it('NEGOTIATION1 → Pending3 is allowed by the table (the has-components skip is blocked by the business guard, not this table)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.WaitingBc.status,
        STATUS_DI.Pending3.status,
      ),
    ).not.toThrow();
  });

  it('refuses CONFIRMATION_COMPOSANTS from a non-INMAGASIN source (e.g. NEGOTIATION1)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.WaitingBc.status,
        STATUS_DI.ConfirmationComposants.status,
      ),
    ).toThrow(GraphQLError);
  });

  // ── DI status flow v2: ATTENTE_BL_FACTURE gate before FINISHED ─────────────

  it('INREPARATION → ATTENTE_BL_FACTURE is allowed (repaired DI enters the doc wait)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.InReparation.status,
        STATUS_DI.WaitingBl.status,
      ),
    ).not.toThrow();
  });

  it('REPARATION_Pause → ATTENTE_BL_FACTURE is allowed (finish from pause)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.ReparationInPause.status,
        STATUS_DI.WaitingBl.status,
      ),
    ).not.toThrow();
  });

  it('WAITING_FACTURE → FINISHED is allowed (auto-close once the facture is uploaded)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.WaitingFacture.status,
        STATUS_DI.Finished.status,
      ),
    ).not.toThrow();
  });

  it('REFUSES the removed direct INREPARATION → FINISHED (must pass through ATTENTE_BL_FACTURE)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.InReparation.status,
        STATUS_DI.Finished.status,
      ),
    ).toThrow(GraphQLError);
  });

  it('REFUSES REPARATION_Pause → FINISHED direct (removed)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.ReparationInPause.status,
        STATUS_DI.Finished.status,
      ),
    ).toThrow(GraphQLError);
  });

  it('non-repairable finishes STILL close directly (DIAGNOSTIC/NEGOTIATION → FINISHED)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.InDiagnostic.status,
        STATUS_DI.Finished.status,
      ),
    ).not.toThrow();
    expect(() =>
      assertDiTransition(
        STATUS_DI.WaitingBc.status,
        STATUS_DI.Finished.status,
      ),
    ).not.toThrow();
  });

  it('the split status VALUES are the new strings', () => {
    expect(STATUS_DI.WaitingDevis.status).toBe('WAITING_DEVIS');
    expect(STATUS_DI.WaitingBc.status).toBe('WAITING_BC');
    expect(STATUS_DI.ConfirmationComposants.status).toBe(
      'ATTENTE_CONFIRMATION_COORDINATION',
    );
    expect(STATUS_DI.WaitingBl.status).toBe('WAITING_BL');
    expect(STATUS_DI.WaitingFacture.status).toBe('WAITING_FACTURE');
  });

  // ── Re-entry sources (retour / annuler) bypass the forward whitelist ────

  it('Annuler → anything in the pipeline is allowed (re-entry source)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.Annuler.status,
        STATUS_DI.WaitingDevis.status,
      ),
    ).not.toThrow();
  });

  // ── Illegal jumps stay refused (the original M1 protection) ─────────────

  it('refuses CREATED → FINISHED', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.Created.status,
        STATUS_DI.Finished.status,
      ),
    ).toThrow(GraphQLError);
  });

  it('refuses CREATED → INDIAGNOSTIC', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.Created.status,
        STATUS_DI.InDiagnostic.status,
      ),
    ).toThrow(GraphQLError);
  });

  it('refuses PRICING → FINISHED', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.Pricing.status,
        STATUS_DI.Finished.status,
      ),
    ).toThrow(GraphQLError);
  });

  it('refuses PENDING1 → REPARATION (skips diag + pricing)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.Pending1.status,
        STATUS_DI.Reparation.status,
      ),
    ).toThrow(GraphQLError);
  });

  // ── Error shape: BAD_REQUEST + currentStatus/targetStatus in extensions ─

  it('refusals carry currentStatus + targetStatus in extensions for the Discord channel', () => {
    try {
      assertDiTransition(
        STATUS_DI.Created.status,
        STATUS_DI.Finished.status,
      );
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphQLError);
      const ext = (err as GraphQLError).extensions as any;
      expect(ext.code).toBe('BAD_REQUEST');
      expect(ext.currentStatus).toBe(STATUS_DI.Created.status);
      expect(ext.targetStatus).toBe(STATUS_DI.Finished.status);
    }
  });

  // ── No-op cases ────────────────────────────────────────────────────────

  it('idempotent re-apply (current === target) is allowed', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.InDiagnostic.status,
        STATUS_DI.InDiagnostic.status,
      ),
    ).not.toThrow();
  });

  it('un-guarded targets (no entry in ALLOWED_TRANSITIONS) are allowed through', () => {
    expect(() =>
      assertDiTransition('CREATED', STATUS_DI.Annuler.status),
    ).not.toThrow();
  });

  // ── Sanity: every `_Pause` status is REPRESENTED in the table ──────────

  it('every `_Pause` source listed in ALLOWED_TRANSITIONS has its active sibling listed too', () => {
    const pauseToActive: Record<string, string> = {
      [STATUS_DI.DiagnosticInPause.status]: STATUS_DI.InDiagnostic.status,
      [STATUS_DI.ReparationInPause.status]: STATUS_DI.InReparation.status,
    };
    for (const [target, sources] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const src of sources) {
        const activeSibling = pauseToActive[src];
        if (!activeSibling) continue;
        // Exception: if the target itself IS the active sibling, the source
        // list doesn't need to redeclare it — `current === target` is the
        // idempotent-re-apply no-op handled at the top of `assertDiTransition`.
        // Example: target `INDIAGNOSTIC` has source `DIAGNOSTIC_Pause` but does
        // not need to also list `INDIAGNOSTIC` as a source.
        if (target === activeSibling) continue;
        expect(sources).toContain(activeSibling);
      }
    }
  });
});

describe('assertDiTransition · handshake magasin↔coordination v2', () => {
  const PREP = STATUS_DI.InMagasin.status; // PROCESSING
  const AWAIT = STATUS_DI.ConfirmationComposants.status; // ATTENTE_CONFIRMATION_COORDINATION
  const FINAL = STATUS_DI.MagasinFinalisation.status; // MAGASIN_FINALISATION
  const P3 = STATUS_DI.Pending3.status;

  it('étape 1→2 : PROCESSING → ATTENTE_CONFIRMATION_COORDINATION autorisée', () => {
    expect(() => assertDiTransition(PREP, AWAIT)).not.toThrow();
  });
  it('étape 2→3 : ATTENTE_CONFIRMATION_COORDINATION → MAGASIN_FINALISATION autorisée', () => {
    expect(() => assertDiTransition(AWAIT, FINAL)).not.toThrow();
  });
  it('étape 3 : MAGASIN_FINALISATION → PENDING3 autorisée', () => {
    expect(() => assertDiTransition(FINAL, P3)).not.toThrow();
  });
  it('saut « aucun composant » : PROCESSING → PENDING3 autorisée', () => {
    expect(() => assertDiTransition(PREP, P3)).not.toThrow();
  });
  it('REFUSÉ — saut de confirmation : PROCESSING → MAGASIN_FINALISATION', () => {
    expect(() => assertDiTransition(PREP, FINAL)).toThrow(GraphQLError);
  });
  it('REFUSÉ — MagasinEstimation → MAGASIN_FINALISATION (pas de raccourci)', () => {
    expect(() =>
      assertDiTransition(STATUS_DI.MagasinEstimation.status, FINAL),
    ).toThrow(GraphQLError);
  });
  it('idempotence : MAGASIN_FINALISATION → MAGASIN_FINALISATION est un no-op', () => {
    expect(() => assertDiTransition(FINAL, FINAL)).not.toThrow();
  });
  it('legacy toléré : CONFIRMATION_COMPOSANTS → MAGASIN_FINALISATION autorisée', () => {
    expect(() =>
      assertDiTransition('CONFIRMATION_COMPOSANTS', FINAL),
    ).not.toThrow();
  });
});
