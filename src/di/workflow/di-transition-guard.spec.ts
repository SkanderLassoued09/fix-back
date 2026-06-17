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

  it('REPARATION_Pause → FINISHED is allowed (mirror of INREPARATION)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.ReparationInPause.status,
        STATUS_DI.Finished.status,
      ),
    ).not.toThrow();
  });

  // ── Multi-source arcs (negotiation → magasin, INMAGASIN → Pending3) ─────

  it('NEGOTIATION1 → InMagasin is allowed (parts-needed branch)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.Negotiation1.status,
        STATUS_DI.InMagasin.status,
      ),
    ).not.toThrow();
  });

  it('INMAGASIN → Pending3 is allowed (magasin completed parts list)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.InMagasin.status,
        STATUS_DI.Pending3.status,
      ),
    ).not.toThrow();
  });

  // ── Re-entry sources (retour / annuler) bypass the forward whitelist ────

  it('Annuler → anything in the pipeline is allowed (re-entry source)', () => {
    expect(() =>
      assertDiTransition(
        STATUS_DI.Annuler.status,
        STATUS_DI.Negotiation1.status,
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
