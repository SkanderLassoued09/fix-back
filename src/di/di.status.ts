export const STATUS_DI = {
  Created: {
    status: 'CREATED',
    description: 'Created by manager and not sent to coordinator',
    role: ['Manager', 'Admin_Manager'],
    future_status: ['Pending 1'],
  },
  Pending1: {
    status: 'PENDING1',
    description: 'Sent to diagnostic',
    role: ['Coordinator'],
    future_status: ['Diagnostic'],
  },
  Diagnostic: {
    status: 'DIAGNOSTIC',
    description: 'Waiting for Diagnostic',
    role: ['Tech'],
    future_status: ['DiagnosticInPause'],
  },
  DiagnosticInPause: {
    status: 'DIAGNOSTIC_Pause',
    description: 'Waiting for Repair',
    role: ['Tech'],
    future_status: ['InDiagnostic'],
  },
  InDiagnostic: {
    status: 'INDIAGNOSTIC',
    description: 'Diagnostic in progress',
    role: ['Tech'],
    future_status: ['Pending2'],
  },
  MagasinEstimation: {
    status: 'MagasinEstimation',
    description: 'Magasin doing the Estimation before the negotiation starts',
    role: ['Magasin'],
    future_status: ['Pending2'],
  },
  // Handshake magasin↔coordination — ÉTAPE 1 : le magasin prépare la liste des
  // composants ; bouton « Envoyer au coordinateur » (→ ATTENTE_CONFIRMATION_
  // COORDINATION), ou saut direct → PENDING3 si aucun composant. CLÉ TS
  // `InMagasin` conservée (identifiant interne stable, référencé partout) ;
  // seule la VALEUR `status` est renommée MAGASIN_PREPARATION → PROCESSING →
  // CONFIRMATION (migration 009). La valeur legacy `PROCESSING` reste tolérée en
  // AFFICHAGE (timeline/maps) le temps de la migration (0 DI vive concernée).
  InMagasin: {
    status: 'CONFIRMATION',
    description: 'CONFIRMATION',
    role: ['Magasin'],
    future_status: ['ConfirmationComposants', 'Pending3'],
  },
  // Phase d'attente de la confirmation coordination : poignée de main magasin
  // ↔ coordinatrice sur la réception des composants. Une DI n'y passe QUE si
  // elle a des composants (`contain_pdr === true` ET `array_composants` non
  // vide) ; sinon elle saute cette étape et va directement en PENDING3. Visible
  // dans les vues Magasin ET Coordinatrice. Fait avancer vers PENDING3 quand le
  // magasin clôture (« Fin liste ») après confirmation de la coordinatrice.
  //
  // NB: la CLÉ TS reste `ConfirmationComposants` (identifiant interne stable,
  // référencé dans le guard/service/map) ; seule la VALEUR `status` (visible en
  // base + UI) est renommée `ATTENTE_CONFIRMATION_COORDINATION`. Une migration
  // renomme les valeurs stockées (0 DI actuellement dans ce statut).
  // ÉTAPE 2 « En attente confirmation Coordination » : la DI est chez la
  // coordinatrice ; bouton « Confirmer les composants » (→ MAGASIN_FINALISATION).
  ConfirmationComposants: {
    status: 'ATTENTE_CONFIRMATION_COORDINATION',
    description: 'En attente confirmation Coordination',
    role: ['Coordinator', 'Magasin'],
    future_status: ['MagasinFinalisation'],
  },
  // ÉTAPE 3 « Finalisation magasin » : composants confirmés par la
  // coordinatrice → la DI revient au magasin ; bouton « Terminer les composants »
  // (→ PENDING3). Statut NOUVEAU qui remplace le flag
  // `isConfirmedComponentFromCoordinator`. Le bug « Fin liste composants » est
  // corrigé À LA RACINE ici : la condition d'ouverture devient le STATUT.
  MagasinFinalisation: {
    status: 'MAGASIN_FINALISATION',
    description: 'Finalisation magasin',
    role: ['Magasin'],
    future_status: ['Pending3'],
  },
  Pending2: {
    status: 'PENDING2',
    description: 'Sent to admins for pricing',
    role: ['Coordinator'],
    future_status: ['Pricing'],
  },
  // Phase « Tarification » : l'admin affecte le COÛT RÉEL du
  // diagnostic (borné 150–500 DT) + saisit une ESTIMATION de réparation, pour
  // comparer ensuite au réel/facturé (détection d'écart). CLÉ TS `Pricing`
  // conservée (identifiant interne stable, référencé dans guard/service/map) ;
  // seule la VALEUR `status` est renommée `PRICING_DIAG`.
  // IMPORTANT : renommage « forward-only » — AUCUN backfill des DI existantes
  // (elles gardent l'ancienne valeur `PRICING`). Seules les DI qui ENTRENT en
  // tarification après ce déploiement portent `PRICING_DIAG`. Le
  // front tolère les deux valeurs (isPricingStatus / maps dual-clés).
  Pricing: {
    status: 'PRICING_DIAG',
    description: 'Pricing (real diagnostic cost + repair estimate)',
    role: ['Admin_Manager', 'Admin_Tech'],
    future_status: ['Negotiation'],
  },
  // Phase « Approval » documentaire — SPLIT de l'ancien `ATTENTE_BC_DEVIS`
  // (ex-clé `Negotiation1`) en DEUX gates séquentiels pilotés par l'upload des
  // documents :
  //   PRICING_DIAG → WAITING_DEVIS → (devis uploadé) → WAITING_BC → (BC uploadé)
  //   → suite du flux (PENDING3 sans composants / PROCESSING avec composants).
  // L'upload du devis fait avancer WAITING_DEVIS → WAITING_BC (aucune décision
  // métier). L'upload du BC (en WAITING_BC) déclenche la MÊME logique que le
  // bouton « Confirmer » (routage repairable/composants), la garde composants de
  // `changeStatusPending3` s'appliquant telle quelle. Échappatoires disponibles
  // depuis les DEUX gates : négocier → NEGOTIATION2, annuler → ANNULER.
  // Legacy : les DI en `ATTENTE_BC_DEVIS`/`NEGOTIATION1` (base non migrée) sont
  // tolérées comme sources via `APPROVAL_DOC_STATUS_VALUES`/`isApprovalDocStatus`
  // et migrées (008) vers WAITING_DEVIS (devis absent) / WAITING_BC (devis présent).
  WaitingDevis: {
    status: 'WAITING_DEVIS',
    description: 'Approval — attente du devis signé',
    role: ['Manager'],
    future_status: ['WaitingBc', 'Negotiation2', 'Annuler'],
  },
  WaitingBc: {
    status: 'WAITING_BC',
    description: 'Approval — attente du bon de commande',
    role: ['Manager'],
    future_status: [
      'Pending3',
      'InMagasin',
      'Negotiation2',
      'Annuler',
      'Finished',
    ],
  },
  Negotiation2: {
    status: 'NEGOTIATION2',
    description: 'Negotiation in progress (20%-25% discount or price change)',
    role: ['Admin_Manager'],
    future_status: ['Pending3', 'Annuler'],
  },
  Pending3: {
    status: 'PENDING3',
    description: 'Sent to repair',
    role: ['Coordinator'],
    future_status: ['Repair'],
  },
  Reparation: {
    status: 'REPARATION',
    description: 'Waiting for Repair',
    role: ['Tech'],
    future_status: ['REPARATION_Pause'],
  },
  ReparationInPause: {
    status: 'REPARATION_Pause',
    description: 'Waiting for Repair',
    role: ['Tech'],
    future_status: ['InReparation'],
  },
  InReparation: {
    status: 'INREPARATION',
    description: 'Repair in progress by tech',
    role: ['Tech'],
    future_status: ['WaitingBl'],
  },
  // Phase de clôture documentaire — SPLIT de l'ancien `CLOSING` (ex-clé
  // `AttenteBlFacture`) en DEUX gates séquentiels pilotés par l'upload :
  //   INREPARATION → WAITING_BL → (BL uploadé) → WAITING_FACTURE → (facture
  //   uploadée) → FINISHED.
  // Avancement AUTOMATIQUE atomique/idempotent à l'upload (`maybeAdvanceDocGate`),
  // avec CASCADE si un document attendu est déjà présent (ex. facture déjà là
  // quand le BL arrive → WAITING_FACTURE puis FINISHED) et UNE SEULE notification
  // finale (`sendDiFinished` au FINISHED réel uniquement). Les fins NON réparables
  // gardent leur clôture directe vers FINISHED (ne passent pas par ces gates).
  // Legacy : les DI en `CLOSING`/`ATTENTE_BL_FACTURE` (base non migrée) sont
  // tolérées via `CLOSING_STATUS_VALUES`/`isClosingStatus` et migrées (008) vers
  // WAITING_BL (BL absent) / WAITING_FACTURE (BL présent).
  WaitingBl: {
    status: 'WAITING_BL',
    description: 'Clôture — attente du bon de livraison',
    // Le Tech a FINI sa réparation : dès WAITING_BL, la DI sort de sa vue (le
    // BL est uploadé par la coordination). Retirer 'Tech' l'exclut de
    // `TECH_STATUS_DI_VALUES` → la DI n'apparaît plus dans la liste technicien.
    role: ['Manager', 'Admin_Tech', 'Admin_Manager'],
    future_status: ['WaitingFacture'],
  },
  WaitingFacture: {
    status: 'WAITING_FACTURE',
    description: 'Clôture — attente de la facture',
    role: ['Tech', 'Manager', 'Admin_Tech', 'Admin_Manager'],
    future_status: ['Finished'],
  },
  Finished: {
    status: 'FINISHED',
    description: 'DI process completed',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager'],
    future_status: ['Retour1'],
  },
  // Statut TERMINAL « équipement irréparable » — clôture d'une DI non réparable.
  // Remplace FINISHED pour les fins NON RÉPARABLES. Deux chemins d'entrée :
  //   - non payant OU retour  → directement depuis le diagnostic (aucun fichier) ;
  //   - payant (flux original) → passe d'abord par PENDING2 → PRICING_DIAG pour
  //     FACTURER le diagnostic, puis clôture en IRREPARABLE à « Valider le prix ».
  // Terminal (`future_status: null`, aucun retour). Mêmes rôles de visibilité que
  // FINISHED (Manager/Admin_Tech/Admin_Manager → hors listes Tech/Magasin/Coord).
  // NB : la VALEUR 'IRREPARABLE' coexiste avec un motif d'ANNULATION homonyme
  // (champ distinct) — aucune collision fonctionnelle.
  Irreparable: {
    status: 'IRREPARABLE',
    description: 'Équipement irréparable — clôturé',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager'],
    future_status: null,
  },
  Annuler: {
    status: 'ANNULER',
    description: 'Cancelled by manager',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager'],
    future_status: ['WaitingDevis'],
  },
  Retour1: {
    status: 'RETOUR1',
    description: 'Retour1',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager', 'Tech'],
    future_status: ['Retour2'],
  },
  Retour2: {
    status: 'RETOUR2',
    description: 'Retour2',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager', 'Tech'],
    future_status: ['Retour3'],
  },
  Retour3: {
    status: 'RETOUR3',
    description: 'Alert generale',
    role: ['Manager', 'Admin_Tech', 'Admin_Manager', 'Tech'],
    future_status: null,
  },
};

/**
 * Phase « Approval » documentaire (WAITING_DEVIS → WAITING_BC). Inclut les
 * valeurs LEGACY (`ATTENTE_BC_DEVIS`, `NEGOTIATION1`) tant que la migration 008
 * n'a pas tourné sur une base donnée : ces DI restent des SOURCES et des cibles
 * d'affichage valides. Sert aux gardes/vues qui traitent l'ensemble de la phase.
 */
export const APPROVAL_DOC_STATUS_VALUES: readonly string[] = [
  'WAITING_DEVIS',
  'WAITING_BC',
  'ATTENTE_BC_DEVIS',
  'NEGOTIATION1',
];

/** True si le statut est dans la phase Approval documentaire (tolérant aux
 *  valeurs legacy `ATTENTE_BC_DEVIS`/`NEGOTIATION1` non encore migrées). */
export function isApprovalDocStatus(status?: string | null): boolean {
  return APPROVAL_DOC_STATUS_VALUES.includes(status ?? '');
}

/**
 * Phase de clôture documentaire (WAITING_BL → WAITING_FACTURE). Inclut les
 * valeurs LEGACY (`CLOSING`, `ATTENTE_BL_FACTURE`) pour rester correct tant que
 * la migration 008 (split) — ni l'ancienne 006 — n'ont pas tourné sur une base.
 */
export const CLOSING_STATUS_VALUES: readonly string[] = [
  'WAITING_BL',
  'WAITING_FACTURE',
  'CLOSING',
  'ATTENTE_BL_FACTURE',
];

/** True si le statut correspond à la phase de clôture documentaire (tolérant
 *  aux anciennes valeurs `CLOSING`/`ATTENTE_BL_FACTURE` non encore migrées). */
export function isClosingStatus(status: string | null | undefined): boolean {
  return CLOSING_STATUS_VALUES.includes(status ?? '');
}

export const TECH_STATUS_DI_VALUES = Object.values(STATUS_DI)
  .filter((status) => status.role.includes('Tech'))
  .map((status) => status.status);

export const MAGASIN_STATUS_DI_VALUES = Object.values(STATUS_DI)
  .filter((status) => status.role.includes('Magasin'))
  .map((status) => status.status);

export const COORDINATOR_STATUS_DI_VALUES = Object.values(STATUS_DI)
  .filter((status) => status.role.includes('Coordinator'))
  .map((status) => status.status)
  // La phase préparation magasin (InMagasin = CONFIRMATION) doit rester visible
  // côté coordinatrice.
  .concat(STATUS_DI.InMagasin.status);
