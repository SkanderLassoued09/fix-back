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
 *   PENDING1 → DIAGNOSTIC → INDIAGNOSTIC → PENDING2 → PRICING → WAITING_DEVIS
 *   → WAITING_BC → PENDING3 → REPARATION → INREPARATION → WAITING_BL →
 *   WAITING_FACTURE → FINISHED
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
// Renommage « forward-only » PRICING → PRICING_DIAG : les DI déjà en
// tarification conservent l'ANCIENNE valeur `PRICING` (aucun backfill). Elles
// doivent rester des SOURCES valides pour les mêmes arcs que la nouvelle valeur,
// sinon elles seraient bloquées en tarification. `STATUS_DI.Pricing.status` =
// nouvelle valeur ; `LEGACY_PRICING` = ancienne (DI pré-déploiement).
const LEGACY_PRICING = 'PRICING';
// Handshake magasin↔coordination v2 — valeur legacy CONFIRMATION_COMPOSANTS
// (ancienne valeur de ATTENTE_CONFIRMATION_COORDINATION) tolérée comme SOURCE
// pour ne pas bloquer les DI déjà en flux. (Plus d'alias INMAGASIN : la valeur
// MAGASIN_PREPARATION → PROCESSING est migrée ; aucune DI ne porte INMAGASIN.)
const LEGACY_CONFIRMATION_COMPOSANTS = 'CONFIRMATION_COMPOSANTS';
// Phase de clôture BL/Facture — anciennes valeurs (avant le SPLIT en
// WAITING_BL → WAITING_FACTURE), tolérées comme SOURCES pour ne pas bloquer les
// DI déjà en attente au moment du déploiement (migration 008 non appliquée).
const LEGACY_ATTENTE_BL_FACTURE = 'ATTENTE_BL_FACTURE';
const LEGACY_CLOSING = 'CLOSING';
// Phase Approval documentaire — anciennes valeurs (avant le SPLIT en
// WAITING_DEVIS → WAITING_BC), tolérées comme SOURCES le temps de la migration.
const LEGACY_ATTENTE_BC_DEVIS = 'ATTENTE_BC_DEVIS';
const LEGACY_NEGOTIATION1 = 'NEGOTIATION1';

export const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  [STATUS_DI.Pending1.status]: [
    STATUS_DI.Created.status,
    // « Renvoyer au diagnostic » — the admin, while pricing a (typically
    // non-repairable) DI, can bounce it back to the coordinator so a
    // technician is re-assigned for a fresh diagnostic. PRICING → PENDING1.
    STATUS_DI.Pricing.status,
    LEGACY_PRICING,
    // NB « Abandonner » (DIAGNOSTIC/INDIAGNOSTIC → PENDING1) n'est
    // VOLONTAIREMENT pas ajouté ici : l'abandon ne passe PAS par ce garde
    // générique (M1). Il emprunte la transition dédiée
    // `TECH_ABANDON_TO_PENDING1` (`strictFrom: true`) + un contrôle explicite
    // dans `abandonDi`. Garder la whitelist stricte préserve le garde-fou
    // « pas de retour arrière accidentel INDIAGNOSTIC → PENDING1 » pour toute
    // AUTRE mutation, sans ouvrir de chemin non voulu.
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
    // Post-approval: a repairable DI WITH components is sent to the magasin to
    // source spare parts. Entry happens at the confirmation (BC uploaded in
    // WAITING_BC) or via negotiation (NEGOTIATION2). Legacy sources tolerated
    // for DIs still in-flight before the split migration (008).
    STATUS_DI.WaitingBc.status,
    STATUS_DI.Negotiation2.status,
    LEGACY_ATTENTE_BC_DEVIS,
    LEGACY_NEGOTIATION1,
  ],
  [STATUS_DI.Pending2.status]: [
    STATUS_DI.InMagasin.status,
    STATUS_DI.InDiagnostic.status,
    // `_Pause` rule: mirror of InDiagnostic.
    STATUS_DI.DiagnosticInPause.status,
    STATUS_DI.MagasinEstimation.status,
  ],
  [STATUS_DI.Pricing.status]: [STATUS_DI.Pending2.status],
  // Nouvelle phase de confirmation des composants : atteinte UNIQUEMENT depuis
  // INMAGASIN (le magasin envoie la DI à la coordinatrice pour confirmation).
  // Le fait qu'une DI n'y arrive QUE si elle a des composants est garanti par
  // le routage front + la garde métier de `changeStatusPending3` (le saut
  // NEGOCIATION → PENDING3 est refusé pour une DI avec composants).
  // ÉTAPE 2 — le magasin « Envoyer au coordinateur » depuis MAGASIN_PREPARATION.
  [STATUS_DI.ConfirmationComposants.status]: [STATUS_DI.InMagasin.status],
  // ÉTAPE 3 — la coordinatrice « Confirmer les composants » → retour magasin.
  [STATUS_DI.MagasinFinalisation.status]: [
    STATUS_DI.ConfirmationComposants.status,
    LEGACY_CONFIRMATION_COMPOSANTS,
  ],
  // Entrée dans la phase Approval documentaire = WAITING_DEVIS (depuis PRICING,
  // ou re-entrée depuis ANNULER). WAITING_BC = après upload du devis (WAITING_
  // DEVIS). On NE peut PAS sauter WAITING_BC sans passer par WAITING_DEVIS.
  [STATUS_DI.WaitingDevis.status]: [
    STATUS_DI.Pricing.status,
    LEGACY_PRICING,
    STATUS_DI.Annuler.status,
  ],
  [STATUS_DI.WaitingBc.status]: [
    STATUS_DI.WaitingDevis.status,
    // Legacy : une DI encore en ATTENTE_BC_DEVIS/NEGOTIATION1 (avec devis déjà
    // présent) peut avancer vers WAITING_BC pendant la fenêtre de migration.
    LEGACY_ATTENTE_BC_DEVIS,
    LEGACY_NEGOTIATION1,
  ],
  // NEGOTIATION2 = échappatoire « négocier » depuis les DEUX gates Approval.
  [STATUS_DI.Negotiation2.status]: [
    STATUS_DI.WaitingDevis.status,
    STATUS_DI.WaitingBc.status,
    LEGACY_ATTENTE_BC_DEVIS,
    LEGACY_NEGOTIATION1,
  ],
  [STATUS_DI.Pending3.status]: [
    // B1 — approval done, no spare parts needed → straight to repair. La
    // confirmation « sans composants » part de WAITING_BC (BC uploadé) via
    // `changeStatusPending3` (garde composants). On NE liste PAS WAITING_DEVIS :
    // impossible de sauter le gate BC. Legacy tolérés (DI pré-migration 008).
    STATUS_DI.WaitingBc.status,
    LEGACY_ATTENTE_BC_DEVIS,
    LEGACY_NEGOTIATION1,
    STATUS_DI.Negotiation2.status,
    // B3 — negotiation done WITH spare parts: the DI is routed to the magasin
    // (INMAGASIN) to source them, then the magasin's "Fin liste composants"
    // (changeStatusPending3) sends it back to the coordinator for repair.
    // This real branch was absent from the linear sequence the table was
    // seeded from, which is why INMAGASIN → PENDING3 was wrongly refused.
    // Kept as a legacy source so DIs already in-flight in INMAGASIN under the
    // old flag-based confirmation still finalize (cohabitation — no migration).
    STATUS_DI.InMagasin.status,
    // B4 — DI with components AFTER the coordinator confirmed reception in the
    // dedicated CONFIRMATION_COMPOSANTS phase. The magasin's "Fin liste"
    // finalizes it to repair. This is the ONLY new-flow path into PENDING3 for
    // a DI that has components.
    STATUS_DI.ConfirmationComposants.status,
    // ÉTAPE 3 → réparation : le magasin « Terminer les composants » depuis
    // MAGASIN_FINALISATION. Legacy CONFIRMATION_COMPOSANTS toléré pour les DI
    // pré-migration encore en flux flag-based.
    STATUS_DI.MagasinFinalisation.status,
    LEGACY_CONFIRMATION_COMPOSANTS,
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
  // Phase de clôture documentaire (SPLIT) — 1er gate WAITING_BL atteint quand le
  // tech termine la réparation (remplace l'ancien INREPARATION → FINISHED
  // direct). `_Pause` inclus (fin depuis pause). PAS depuis les états non
  // réparables : ceux-là ferment directement (voir Finished ci-dessous).
  [STATUS_DI.WaitingBl.status]: [
    STATUS_DI.InReparation.status,
    STATUS_DI.ReparationInPause.status,
    STATUS_DI.Reparation.status,
  ],
  // 2e gate WAITING_FACTURE = après upload du BL (WAITING_BL). Legacy tolérés
  // (DI encore en CLOSING/ATTENTE_BL_FACTURE avec BL déjà présent) pendant la
  // fenêtre de migration 008.
  [STATUS_DI.WaitingFacture.status]: [
    STATUS_DI.WaitingBl.status,
    LEGACY_CLOSING,
    LEGACY_ATTENTE_BL_FACTURE,
  ],
  [STATUS_DI.Finished.status]: [
    // Chemin RÉPARÉ : la clôture vient de la FIN de la chaîne documentaire —
    // WAITING_FACTURE (facture uploadée). La transition auto ne fire qu'une fois
    // la facture présente (helper `maybeAdvanceDocGate`). Legacy CLOSING/
    // ATTENTE_BL_FACTURE tolérés (DI en vol avant migration 008).
    STATUS_DI.WaitingFacture.status,
    LEGACY_CLOSING,
    LEGACY_ATTENTE_BL_FACTURE,
    // Non-repairable DI: finished right after approval/negotiation, no repair.
    // (Ces fins ne passent PAS par les gates documentaires — décision produit.)
    STATUS_DI.WaitingDevis.status,
    STATUS_DI.WaitingBc.status,
    STATUS_DI.Negotiation2.status,
    LEGACY_ATTENTE_BC_DEVIS,
    LEGACY_NEGOTIATION1,
    // Non-repairable shortcut from diagnostic: when the tech marks the DI as
    // `can_be_repaired: false` during diagnostic, the modal's "Terminer (non
    // réparable)" action moves it straight to FINISHED — no magasin, no
    // pricing, no repair. Allowed from the active diagnostic state AND its
    // paused sibling (same `_Pause` equivalence rule applied elsewhere).
    STATUS_DI.Diagnostic.status,
    STATUS_DI.InDiagnostic.status,
    STATUS_DI.DiagnosticInPause.status,
  ],
  // Statut TERMINAL « irréparable » — clôture d'une DI non réparable. Sources
  // autorisées :
  //   - les trois états de diagnostic (verdict non réparable : non-payant en
  //     direct, ou retour) — miroir de la clôture FINISHED non réparable ;
  //   - PRICING_DIAG : cas PAYANT (flux original) — après facturation du
  //     diagnostic, « Valider le prix » clôture en IRREPARABLE ;
  //   - la phase Approval (WAITING_DEVIS/WAITING_BC/NEGOTIATION2 + legacy) : une
  //     DI jugée non réparable pendant la négociation ferme aussi en IRREPARABLE
  //     (miroir de la branche non-réparable de « Confirmer » / exitWaitingBcOnBc).
  // IRREPARABLE n'est source d'AUCUNE transition (terminal) et n'est pas dans
  // REENTRY_SOURCES.
  [STATUS_DI.Irreparable.status]: [
    STATUS_DI.Diagnostic.status,
    STATUS_DI.InDiagnostic.status,
    STATUS_DI.DiagnosticInPause.status,
    STATUS_DI.Pricing.status,
    STATUS_DI.WaitingDevis.status,
    STATUS_DI.WaitingBc.status,
    STATUS_DI.Negotiation2.status,
    LEGACY_ATTENTE_BC_DEVIS,
    LEGACY_NEGOTIATION1,
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
