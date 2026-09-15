#!/usr/bin/env node
/**
 * JEU DE SCÉNARIOS DI — seed unique pour le test à la main, FLUX ORIGINAL ET RETOUR
 * CÔTE À CÔTE.
 *
 * Chaque ÉTAPE du flux (un statut) est posée en PAIRE :
 *   `SC-<étape>-O`   flux ORIGINAL (cycle 0) ;
 *   `SC-<étape>-R`   la même étape en RETOUR 1, erreur client ;
 *   `SC-<étape>-RF`  en RETOUR 1, erreur Fixtronix ;
 *   suffixes `2` (retour 2), `P` (avec pièces), `X` (verdict à saisir).
 * Une DI retour porte un VRAI flux original derrière elle, comme en base : cycle 0
 * clos à la date du retour (dates, prix, 4 documents nommés), une Stat par cycle,
 * le motif du retour sur la ligne du cycle ET dans le journal (`DI_RETOUR_n`).
 * Des DI attendent aussi en RETOUR1 / RETOUR2 (filtre statut « Retour1 »).
 *
 * Le script PROUVE le routage en tirant les vraies mutations GraphQL sur des DI
 * jetables (`DI_scnv_`), puis reseede un jeu propre.
 *
 *   node scripts/seed-scenarios.mjs              # purge → vérifie → seed → rapport
 *   node scripts/seed-scenarios.mjs --clean      # purge seule
 *   node scripts/seed-scenarios.mjs --no-verify  # seed sans backend (:3000 éteint)
 *   node scripts/seed-scenarios.mjs --only=A,C   # limite à des groupes (purge ces groupes seulement)
 *   MONGO_DB=fixtronixproddb node scripts/seed-scenarios.mjs
 *
 * ⚠️ Écrit dans `fixtronixproddb`, la base que l'app lit réellement (aucune base
 * de test isolée n'existe). TOUT est préfixé `DI_scn_` et la purge ne touche que
 * ce préfixe — les DI de travail ne sont jamais approchées.
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildDiTriple, purgeSeed, resolveRefs, writeTriple } from '../utils/di-seed.mjs';

const require = createRequire(import.meta.url);
const { MongoClient } = require('mongodb');
const HERE = dirname(fileURLToPath(import.meta.url));

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const GRAPHQL_URL = (process.env.API_URL ?? 'http://localhost:3000') + '/graphql';
const PREFIX = 'DI_scn_';
const VERIFY_PREFIX = 'DI_scnv_';

const argv = process.argv.slice(2);
const CLEAN = argv.includes('--clean');
const NO_VERIFY = argv.includes('--no-verify');
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// LA MATRICE
//
// Le routage attendu est dérivé du CODE, pas du diagramme :
//   changeStatusMagasinEstimation, changeStatusPending2, changeStatusTofinsh (di.service.ts)
// Règle du 2026-09-15 : un retour AVEC pièces (erreur client OU Fixtronix) passe
// par magasin → PENDING2 → tarification. Fixtronix SANS pièces reste PENDING3
// direct (jamais tarifé) ; un retour NON réparable clôture en IRREPARABLE.
//
// `verify` = la mutation que le FRONT tire réellement pour ce geste, et le statut
// attendu ensuite. `verify: null` ⇒ cas amorcé mais non auto-vérifiable.
// ─────────────────────────────────────────────────────────────────────────────

const M = {
  magasinEstimation: (id) => `mutation { changeStatusMagasinEstimation(_id:"${id}") }`,
  pending2: (id) => `mutation { changeStatusPending2(_id:"${id}") }`,
  toFinish: (id) => `mutation { changestatusToFinishReparation(_id:"${id}") { _id status } }`,
  pending3: (id) => `mutation { changeStatusPending3(_id:"${id}") }`,
  sendToCoord: (id) => `mutation { sendComponentToConMagasinForConfirmation(_id:"${id}") { _id status } }`,
  coordConfirm: (id) => `mutation { componentConfirmedFromCoordinator(_id:"${id}") { _id status } }`,
  pricing: (id) => `mutation { changeStatusPricing(_id:"${id}") }`,
  irreparableFromPricing: (id) => `mutation { changeStatusIrreparableFromPricing(_id:"${id}") }`,
  repaire: (id) => `mutation { changeStatusRepaire(_id:"${id}") }`,
  retour: (id) => `mutation { changeStatusRetour(_id:"${id}", reason:"QA scénario") { level di { _id status } } }`,
  coordToDiag: (id) => `mutation { coordinatorSendingDiDiag(_idDI:"${id}") { _id status } }`,
  pending1: (id) => `mutation { changeStatusPending1(_id:"${id}") }`,
  // « Valider le prix » en tarification : PRICING_DIAG → WAITING_DEVIS (entrée
  // dans l'Approval). Le nom `Negociate1` est historique.
  validerPrix: (id) => `mutation { changeStatusNegociate1(_id:"${id}") }`,
  negocier: (id) => `mutation { changeStatusNegociate2(_id:"${id}") }`,
  adminPending3: (id) => `mutation { managerAdminManager_Pending3(_id:"${id}") { _id status } }`,
  inDiagnostic: (id) => `mutation { changeStatusInDiagnostic(_id:"${id}") }`,
  inRepair: (id) => `mutation { changeStatusInRepair(_id:"${id}") }`,
  reactiver: (id) => `mutation { reactiverDi(diId:"${id}") { _id status } }`,
};

/** Un retour Fixtronix SANS pièce saute magasin et tarification : PENDING3 direct. */
const FIXTRONIX_SHORTCUT = { PENDING3: 'INDIAGNOSTIC' };

// Une ÉTAPE = un statut ; ses `variants` la déclinent en flux original / retour.
// Champs d'une variante : v (suffixe), cycle, rep, pdr, fixtronix, payant, comps,
// status/role (sinon ceux de l'étape), extra, parentOverrides, next, verify.

/** GROUPE A — fin de diagnostic technicien (INDIAGNOSTIC). */
const GROUP_A = [
  {
    step: 'A1', status: 'INDIAGNOSTIC', label: 'Fin de diagnostic — réparable + PDR',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: true,
        next: 'Tech : « Finir le diagnostic » → MagasinEstimation → PENDING2 → tarification → devis → BC → '
          + 'poignée de main composants → PENDING3 → réparation.',
        verify: { fire: M.magasinEstimation, expect: 'MagasinEstimation' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: true,
        next: 'Tech : « Fin diagnostique retour » → MagasinEstimation → PENDING2 → tarification. Erreur client : facturé.',
        verify: { fire: M.magasinEstimation, expect: 'MagasinEstimation' },
      },
      {
        v: 'RF', cycle: 1, fixtronix: true, rep: true, pdr: true,
        next: 'Même chemin que R (règle du 15/09) : magasin → PENDING2 → tarification, où « Facturer le diagnostic ? » '
          + 'décide (Non = diagnostic et réparation à 0).',
        verify: { fire: M.magasinEstimation, expect: 'MagasinEstimation' },
      },
    ],
  },
  {
    step: 'A2', status: 'INDIAGNOSTIC', label: 'Fin de diagnostic — PDR coché SANS composant (cas négatif)',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: true, comps: [],
        next: 'Tech : cocher « contient des PDR » sans composant → le SERVEUR REFUSE (« PDR déclaré sans composant »).',
        verify: { fire: M.magasinEstimation, expectError: /PDR déclaré sans composant/ },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: true, comps: [],
        next: 'En retour, une case PDR sans pièce compte comme « sans PDR » : erreur client → PENDING2 (pas de magasin '
          + 'les mains vides). Le front bloque déjà la saisie.',
        verify: { fire: M.magasinEstimation, expect: 'PENDING2' },
      },
    ],
  },
  {
    step: 'A3', status: 'INDIAGNOSTIC', label: 'Fin de diagnostic — réparable sans PDR',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false, payant: true,
        next: 'Tech : décocher « contient des PDR » → « Finir le diagnostic » → PENDING2 (magasin sauté) → tarification.',
        verify: { fire: M.pending2, expect: 'PENDING2' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false, payant: true,
        next: 'Tech : décocher PDR → « Fin diagnostique retour » → PENDING2. Les DEUX boutons retour donnent le même statut.',
        verify: { fire: M.pending2, expect: 'PENDING2', alsoVia: M.toFinish },
      },
      {
        v: 'RF', cycle: 1, fixtronix: true, rep: true, pdr: false,
        next: 'Tech : décocher PDR → « Fin diagnostique retour » → PENDING3 DIRECT (magasin ET tarification sautés, '
          + 'non facturé). Coordinatrice : joindre le devis puis envoyer en réparation (E1-RF).',
        verify: { fire: M.pending2, expect: 'PENDING3', alsoVia: M.toFinish },
      },
      {
        v: 'RF2', cycle: 2, fixtronix: true, rep: true, pdr: false,
        next: 'Même attendu que RF (PENDING3) au 2e retour : le verdict est lu sur le cycle COURANT (idIgnore=2).',
        verify: { fire: M.pending2, expect: 'PENDING3', alsoVia: M.toFinish },
      },
      {
        v: 'RX', cycle: 1, fixtronix: null, rep: true, pdr: false,
        next: 'État réel d\'un retour avant que le tech ne tranche. Étape Validation : COCHER « Erreur Fixtronix », '
          + 'décocher PDR → « Fin diagnostique retour » → PENDING3. Bonus : pause après avoir coché → le verdict survit.',
        verify: null,
      },
    ],
  },
  {
    step: 'A4', status: 'INDIAGNOSTIC', label: 'Fin de diagnostic — réparable sans PDR, diagnostic NON payant',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false, payant: false,
        next: 'Tech : idem A3 → PENDING2. Tarification : écran reprixé (seul le prix de réparation est saisi).',
        verify: { fire: M.pending2, expect: 'PENDING2' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false, payant: false,
        next: 'Tech : → PENDING2. Tarification : bascule « Facturer le diagnostic ? » sur Non = rien facturé.',
        verify: { fire: M.pending2, expect: 'PENDING2', alsoVia: M.toFinish },
      },
    ],
  },
  {
    step: 'A5', status: 'INDIAGNOSTIC', label: 'Fin de diagnostic — NON réparable, diagnostic payant',
    variants: [
      {
        v: 'O', cycle: 0, rep: false, pdr: false, payant: true,
        next: 'Tech : « Terminer (non réparable) » → PENDING2 ; Admin : « Valider le prix » → IRREPARABLE facturé (D4-O).',
        verify: { fire: M.toFinish, expect: 'PENDING2' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: false, pdr: false, payant: true,
        next: 'Tech : décocher « réparable » → « Fin diagnostique retour » → IRREPARABLE. En retour on ne refacture pas.',
        verify: { fire: M.toFinish, expect: 'IRREPARABLE' },
      },
      {
        v: 'RF', cycle: 1, fixtronix: true, rep: false, pdr: false,
        next: 'Tech : → IRREPARABLE, AUCUNE facturation (notre faute).',
        verify: { fire: M.toFinish, expect: 'IRREPARABLE' },
      },
    ],
  },
  {
    step: 'A6', status: 'INDIAGNOSTIC', label: 'Fin de diagnostic — NON réparable, diagnostic NON payant',
    variants: [
      {
        v: 'O', cycle: 0, rep: false, pdr: false, payant: false,
        next: 'Tech : « Terminer (non réparable) » → IRREPARABLE immédiatement, aucune facturation.',
        verify: { fire: M.toFinish, expect: 'IRREPARABLE' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: false, pdr: false, payant: false,
        next: 'Tech : → IRREPARABLE, aucune facturation.',
        verify: { fire: M.toFinish, expect: 'IRREPARABLE' },
      },
    ],
  },
];

/** GROUPE B — amont du diagnostic, et retours ouverts en attente. */
const GROUP_B = [
  {
    step: 'B1', label: 'Point de départ d\'un cycle',
    variants: [
      {
        v: 'O', status: 'CREATED', role: 'Manager', cycle: 0, rep: true, pdr: false,
        next: 'Manager / Admin : envoyer au coordinateur → PENDING1.',
        verify: { fire: M.pending1, expect: 'PENDING1' },
      },
      {
        v: 'R', status: 'RETOUR1', role: 'Coordinator', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Retour 1 OUVERT : flux original terminé derrière (dates, prix, 4 documents, motif). Visible avec le filtre '
          + 'statut « Retour1 ». Coordinatrice : relancer → PENDING1 puis réaffecter un technicien.',
        verify: { fire: M.pending1, expect: 'PENDING1' },
      },
      {
        v: 'R2', status: 'RETOUR2', role: 'Coordinator', cycle: 2, fixtronix: false, rep: true, pdr: false,
        next: 'Retour 2 OUVERT : deux cycles clos derrière (sélecteur Flux original / Retour 1 dans le détail DI, '
          + 'un motif par retour). Coordinatrice : relancer → PENDING1.',
        verify: { fire: M.pending1, expect: 'PENDING1' },
      },
    ],
  },
  {
    step: 'B2', status: 'PENDING1', role: 'Coordinator', label: 'Chez la coordinatrice, à affecter au diagnostic',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Coordinatrice : affecter un technicien → DIAGNOSTIC.',
        verify: { fire: M.coordToDiag, expect: 'DIAGNOSTIC' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Retour 1 relancé : la coordinatrice réaffecte un technicien → DIAGNOSTIC.',
        verify: { fire: M.coordToDiag, expect: 'DIAGNOSTIC' },
      },
    ],
  },
  {
    step: 'B3', status: 'DIAGNOSTIC', label: 'Affectée au technicien, diagnostic pas encore ouvert',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Tech : ouvrir la loupe → INDIAGNOSTIC, le chrono démarre.',
        verify: { fire: M.inDiagnostic, expect: 'INDIAGNOSTIC', as: 'TECH' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Tech : ouvrir → INDIAGNOSTIC ; la ligne affiche « Retour 1 » et le chrono du cycle 1 part de zéro.',
        verify: { fire: M.inDiagnostic, expect: 'INDIAGNOSTIC', as: 'TECH' },
      },
    ],
  },
  {
    step: 'B4', status: 'DIAGNOSTIC_Pause', label: 'Diagnostic EN PAUSE — reprise',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Tech : le libellé du bouton vient du STATUT. Reprendre → INDIAGNOSTIC, sans rechargement de la liste.',
        verify: { fire: M.inDiagnostic, expect: 'INDIAGNOSTIC', as: 'TECH' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Tech : reprendre → INDIAGNOSTIC (retour 1).',
        verify: { fire: M.inDiagnostic, expect: 'INDIAGNOSTIC', as: 'TECH' },
      },
    ],
  },
];

/** GROUPE C — magasin et poignée de main composants. */
const GROUP_C = [
  {
    step: 'C1', status: 'MagasinEstimation', role: 'Magasin', label: 'Sortie magasin — avec PDR',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: true,
        next: 'Magasin : « Terminer l\'estimation » → PENDING2 → tarification.',
        verify: { fire: M.pending2, expect: 'PENDING2' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: true,
        next: 'Magasin : « Terminer l\'estimation » → PENDING2. Le client reste facturé.',
        verify: { fire: M.pending2, expect: 'PENDING2' },
      },
      {
        v: 'RF', cycle: 1, fixtronix: true, rep: true, pdr: true,
        next: 'Magasin : « Terminer l\'estimation » → PENDING2 → tarification (plus de détour CONFIRMATION depuis le 15/09).',
        verify: { fire: M.pending2, expect: 'PENDING2' },
      },
    ],
  },
  {
    step: 'C2', status: 'CONFIRMATION', role: 'Magasin', label: 'Poignée de main 1/3 — le magasin prépare la liste',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: true,
        next: 'Magasin : « Envoyer au coordinateur » → ATTENTE_CONFIRMATION_COORDINATION.',
        verify: { fire: M.sendToCoord, expect: 'ATTENTE_CONFIRMATION_COORDINATION' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: true,
        next: 'Même geste en retour 1 : les statuts de la poignée de main sont identiques au flux original.',
        verify: { fire: M.sendToCoord, expect: 'ATTENTE_CONFIRMATION_COORDINATION' },
      },
    ],
  },
  {
    step: 'C3', status: 'ATTENTE_CONFIRMATION_COORDINATION', role: 'Coordinator', label: 'Poignée de main 2/3 — attente de la coordinatrice',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: true,
        next: 'Coordinatrice : « Confirmer les composants » → MAGASIN_FINALISATION.',
        verify: { fire: M.coordConfirm, expect: 'MAGASIN_FINALISATION' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: true,
        next: 'Coordinatrice : confirmer les composants du retour 1 → MAGASIN_FINALISATION.',
        verify: { fire: M.coordConfirm, expect: 'MAGASIN_FINALISATION' },
      },
    ],
  },
  {
    step: 'C4', status: 'MAGASIN_FINALISATION', role: 'Magasin', label: 'Poignée de main 3/3 — finalisation magasin',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: true,
        next: 'Magasin : « Terminer les composants » → PENDING3. Stock décrémenté UNE SEULE FOIS.',
        verify: { fire: M.pending3, expect: 'PENDING3' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: true,
        next: 'Magasin : « Terminer les composants » → PENDING3 (décrément du cycle retour, une seule fois).',
        verify: { fire: M.pending3, expect: 'PENDING3' },
      },
    ],
  },
];

/** GROUPE D — tarification et approbation documentaire. */
const GROUP_D = [
  {
    step: 'D1', status: 'PENDING2', role: 'Coordinator', label: 'Chez la coordinatrice, à envoyer en tarification',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false, payant: true,
        next: 'Coordinatrice : envoyer aux admins pour tarification → PRICING_DIAG.',
        verify: { fire: M.pricing, expect: 'PRICING_DIAG' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Coordinatrice : envoyer en tarification → PRICING_DIAG.',
        verify: { fire: M.pricing, expect: 'PRICING_DIAG' },
      },
      {
        v: 'RFP', cycle: 1, fixtronix: true, rep: true, pdr: true,
        next: 'Retour Fixtronix AVEC pièces : envoi en tarification AUTORISÉ → PRICING_DIAG.',
        verify: { fire: M.pricing, expect: 'PRICING_DIAG' },
      },
      {
        v: 'RF', cycle: 1, fixtronix: true, rep: true, pdr: false, parentOverrides: { PENDING2: 'INDIAGNOSTIC' },
        next: 'Cas négatif : un retour Fixtronix SANS pièce n\'est jamais tarifé → le serveur REFUSE.',
        verify: { fire: M.pricing, expectError: /erreur Fixtronix/ },
      },
    ],
  },
  {
    step: 'D2', status: 'PRICING_DIAG', role: 'Admin_Manager', label: 'Tarification — diagnostic payant',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false, payant: true,
        next: 'Admin : saisir le prix du diagnostic + l\'estimation de réparation → « Valider le prix » → WAITING_DEVIS.',
        verify: { fire: M.validerPrix, expect: 'WAITING_DEVIS' },
      },
      {
        v: 'RP', cycle: 1, fixtronix: false, rep: true, pdr: true, payant: true,
        next: 'Admin : bascule « Facturer le diagnostic ? » visible. Oui = diag (0 accepté en retour) + estimation ; '
          + 'Non = diag ET réparation grisés à 0. « Valider le prix » → WAITING_DEVIS.',
        verify: { fire: M.validerPrix, expect: 'WAITING_DEVIS' },
      },
      {
        v: 'RFP', cycle: 1, fixtronix: true, rep: true, pdr: true, payant: false,
        next: 'Admin : même bascule, Fixtronix inclus, amorcée sur « Non » : rien facturé. « Valider le prix » → WAITING_DEVIS.',
        verify: { fire: M.validerPrix, expect: 'WAITING_DEVIS' },
      },
    ],
  },
  {
    step: 'D3', status: 'PRICING_DIAG', role: 'Admin_Manager', label: 'Tarification — diagnostic NON payant',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false, payant: false,
        next: 'Admin : on ne saisit QUE le prix de réparation ; le serveur calcule le final (setRepairFinalPrice).',
        verify: { fire: M.validerPrix, expect: 'WAITING_DEVIS' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false, payant: false,
        next: 'Admin : bascule sur « Non payant » → diag + réparation grisés, rien facturé. « Valider le prix » → WAITING_DEVIS.',
        verify: { fire: M.validerPrix, expect: 'WAITING_DEVIS' },
      },
    ],
  },
  {
    step: 'D4', status: 'PRICING_DIAG', role: 'Admin_Manager', label: 'Tarification — NON réparable, payant',
    variants: [
      {
        v: 'O', cycle: 0, rep: false, pdr: false, payant: true,
        next: 'Admin : « Valider le prix » → IRREPARABLE facturé. Pas de jumeau retour : un retour non réparable '
          + 'clôture IRREPARABLE dès le diagnostic (A5-R).',
        verify: { fire: M.irreparableFromPricing, expect: 'IRREPARABLE' },
      },
    ],
  },
  {
    step: 'D5', status: 'WAITING_DEVIS', role: 'Manager', label: 'Approbation 1/2 — attente du devis signé',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Téléverser le devis → WAITING_BC automatiquement. Négocier → NEGOTIATION2, annuler → ANNULER.',
        verify: { fire: M.negocier, expect: 'NEGOTIATION2' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Devis du RETOUR 1 : il doit se ranger dans le cycle 1, jamais dans les fichiers du flux original.',
        verify: { fire: M.negocier, expect: 'NEGOTIATION2' },
      },
    ],
  },
  {
    step: 'D6', status: 'WAITING_BC', role: 'Manager', label: 'Approbation 2/2 — attente du bon de commande (sans composants)',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Téléverser le BC → sans composants → PENDING3 ; avec composants → CONFIRMATION.',
        verify: { fire: M.pending3, expect: 'PENDING3' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'BC du RETOUR 1 → PENDING3.',
        verify: { fire: M.pending3, expect: 'PENDING3' },
      },
    ],
  },
  {
    step: 'D7', status: 'NEGOTIATION2', role: 'Admin_Manager', label: 'Négociation (remise ou changement de prix)',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Admin : conclure → PENDING3, ou abandonner → ANNULER.',
        verify: { fire: M.adminPending3, expect: 'PENDING3' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Admin : conclure la négociation du retour 1 → PENDING3.',
        verify: { fire: M.adminPending3, expect: 'PENDING3' },
      },
    ],
  },
];

const REPAIR_NEXT = 'Tech : clé → « Travaux & tests », répondre Réparation réussie / Tests validés → « Fin réparation » '
  + '→ WAITING_BL. Détail DI → Dossier → État : les réponses sur CE cycle seulement.';

/** GROUPE E — réparation et clôture. */
const GROUP_E = [
  {
    step: 'E1', status: 'PENDING3', role: 'Coordinator', label: 'Prête pour la réparation',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Coordinatrice : affecter le technicien réparateur → REPARATION.',
        verify: { fire: M.repaire, expect: 'REPARATION' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Coordinatrice : affecter le réparateur du retour 1 → REPARATION.',
        verify: { fire: M.repaire, expect: 'REPARATION' },
      },
      {
        v: 'RF', cycle: 1, fixtronix: true, rep: true, pdr: false, parentOverrides: FIXTRONIX_SHORTCUT,
        extra: { needsDevisBeforeRepair: true },
        next: 'Raccourci retour Fixtronix sans pièce (suite d\'A3-RF) : la coordinatrice doit JOINDRE LE DEVIS en '
          + 'envoyant en réparation (un seul geste). Non facturé.',
        verify: null,
      },
    ],
  },
  {
    step: 'E2', status: 'REPARATION', label: 'Affectée en réparation, pas encore ouverte',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Tech : ouvrir → INREPARATION, le chrono de réparation démarre.',
        verify: { fire: M.inRepair, expect: 'INREPARATION', as: 'TECH' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Tech : ouvrir la réparation du retour 1 → INREPARATION.',
        verify: { fire: M.inRepair, expect: 'INREPARATION', as: 'TECH' },
      },
    ],
  },
  {
    step: 'E3', status: 'INREPARATION', label: 'Réparation en cours',
    variants: [
      { v: 'O', cycle: 0, rep: true, pdr: false, next: REPAIR_NEXT + ' La DI sort ensuite de la vue technicien.', verify: { fire: M.toFinish, expect: 'WAITING_BL' } },
      { v: 'OP', cycle: 0, rep: true, pdr: true, next: REPAIR_NEXT, verify: { fire: M.toFinish, expect: 'WAITING_BL' } },
      { v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false, next: REPAIR_NEXT, verify: { fire: M.toFinish, expect: 'WAITING_BL' } },
      { v: 'RP', cycle: 1, fixtronix: false, rep: true, pdr: true, next: REPAIR_NEXT, verify: { fire: M.toFinish, expect: 'WAITING_BL' } },
      {
        v: 'RF', cycle: 1, fixtronix: true, rep: true, pdr: false, parentOverrides: FIXTRONIX_SHORTCUT,
        next: REPAIR_NEXT + ' (suite d\'E1-RF une fois le devis joint)', verify: { fire: M.toFinish, expect: 'WAITING_BL' },
      },
      { v: 'RFP', cycle: 1, fixtronix: true, rep: true, pdr: true, next: REPAIR_NEXT, verify: { fire: M.toFinish, expect: 'WAITING_BL' } },
      {
        v: 'R2P', cycle: 2, fixtronix: false, rep: true, pdr: true,
        next: REPAIR_NEXT + ' Sélecteur de cycle : Flux original / Retour 1 clos, Retour 2 = tes réponses.',
        verify: { fire: M.toFinish, expect: 'WAITING_BL' },
      },
    ],
  },
  {
    step: 'E4', status: 'REPARATION_Pause', label: 'Réparation EN PAUSE',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Tech : reprendre → répondre aux deux questions → pause → reprendre : réponses restaurées → « Fin réparation » → WAITING_BL.',
        verify: { fire: M.toFinish, expect: 'WAITING_BL' },
      },
      {
        v: 'RF', cycle: 1, fixtronix: true, rep: true, pdr: false, parentOverrides: FIXTRONIX_SHORTCUT,
        next: 'Même geste en retour Fixtronix : la pause n\'efface rien en base.',
        verify: { fire: M.toFinish, expect: 'WAITING_BL' },
      },
    ],
  },
  {
    step: 'E5', status: 'WAITING_BL', role: 'Manager', label: 'Clôture 1/2 — attente du bon de livraison',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Téléverser le BL → WAITING_FACTURE. La DI n\'est PLUS dans la liste technicien.',
        verify: null,
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'BL du retour 1 → WAITING_FACTURE ; il se range dans le cycle 1.',
        verify: null,
      },
    ],
  },
  {
    step: 'E6', status: 'WAITING_FACTURE', role: 'Manager', label: 'Clôture 2/2 — attente de la facture',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Téléverser la facture → FINISHED, avec UNE SEULE notification finale.',
        verify: null,
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Trombone → « Fichiers principaux » = les 4 documents du FLUX D\'ORIGINE (`-c0`), « Historique des retours » '
          + '= Retour N°1 seulement (`-c1`). Téléverser la facture → FINISHED.',
        verify: null,
      },
    ],
  },
  {
    step: 'E7', status: 'FINISHED', role: 'Manager', label: 'Terminée — point de départ d\'un retour',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Ouvrir un retour → RETOUR1 : le cycle 0 est clos, le miroir de la DI remis à zéro, un dossier de cycle ouvert.',
        verify: { fire: M.retour, expect: 'RETOUR1' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Retour 1 terminé : ouvrir un 2e retour → RETOUR2 ; le cycle 1 est clos à son tour.',
        verify: { fire: M.retour, expect: 'RETOUR2' },
      },
    ],
  },
];

/** GROUPE F — terminaux. */
const GROUP_F = [
  {
    step: 'F1', status: 'IRREPARABLE', role: 'Manager', label: 'Équipement irréparable — clôturé',
    variants: [
      {
        v: 'O', cycle: 0, rep: false, pdr: false, payant: false,
        next: 'Statut TERMINAL : hors des listes Tech / Magasin / Coordination.',
        verify: null,
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: false, pdr: false,
        next: 'Retour clôturé irréparable : le flux original reste consultable dans le détail (cycle 0).',
        verify: null,
      },
    ],
  },
  {
    step: 'F2', status: 'ANNULER', role: 'Manager', label: 'Annulée — réactivable une fois',
    variants: [
      {
        v: 'O', cycle: 0, rep: true, pdr: false,
        next: 'Coordinatrice / Admin : « Réactiver » → statut précédent lu dans statusHistory. Rôle TECH exclu.',
        verify: { fire: M.reactiver, expect: 'PENDING2' },
      },
      {
        v: 'R', cycle: 1, fixtronix: false, rep: true, pdr: false,
        next: 'Retour 1 annulé : « Réactiver » → statut précédent du cycle 1.',
        verify: { fire: M.reactiver, expect: 'PENDING2' },
      },
    ],
  },
];

const GROUPS = { A: GROUP_A, B: GROUP_B, C: GROUP_C, D: GROUP_D, E: GROUP_E, F: GROUP_F };
const GROUP_TITLES = {
  A: 'Fin de diagnostic technicien — INDIAGNOSTIC',
  B: 'Amont du diagnostic et retours ouverts',
  C: 'Magasin et poignée de main composants',
  D: 'Tarification et approbation documentaire',
  E: 'Réparation et clôture',
  F: 'Terminaux',
};
/** Écran où se joue chaque groupe, pour le plan de test final. */
const GROUP_SCREEN = {
  A: ['/tickets/ticket/tech-di-list', 'tech'],
  B: ['/tickets/ticket/ticket-list (filtre statut « Retour1 ») puis coordinator-di-list', 'skander / coordinatrice'],
  C: ['/tickets/ticket/magasin-di-list (+ coordinator-di-list pour C3)', 'magasin / coordinatrice'],
  D: ['/tickets/ticket/ticket-list', 'skander (admin)'],
  E: ['/tickets/ticket/coordinator-di-list puis tech-di-list', 'coordinatrice / tech'],
  F: ['/tickets/ticket/ticket-list', 'skander (admin)'],
};

function flowLabel(c) {
  if (!c.cycle) return 'ORIGINAL';
  const who = c.fixtronix === true ? 'Fixtronix' : c.fixtronix === false ? 'client' : 'verdict à saisir';
  return `RETOUR ${c.cycle} ${who}`;
}

/** Les DI d'un groupe : une par variante de chaque étape. */
function casesOf(group) {
  return GROUPS[group].flatMap((s) =>
    s.variants.map((v) => {
      const c = { status: s.status, role: s.role, ...v, step: s.step, group };
      c.cycle = c.cycle ?? 0;
      c.key = `${s.step}-${v.v}`;
      c.idnum = `SC-${s.step}-${v.v}`;
      c.title = `${flowLabel(c)} · ${s.label}`;
      return c;
    }),
  );
}

function selectedGroups() {
  const keys = Object.keys(GROUPS);
  if (!ONLY.length) return keys;
  const bad = ONLY.filter((g) => !keys.includes(g));
  if (bad.length) throw new Error(`Groupe inconnu dans --only : ${bad.join(', ')} (attendu : ${keys.join(', ')})`);
  return ONLY;
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Jeton d'un rôle, lu dans le storageState Playwright. La plupart des mutations
 * de statut sont NON gardées (le token admin suffit), mais les gestes de travail
 * du technicien passent par `assertTechOwnsDi` : ils exigent le jeton du tech
 * réellement affecté. D'où un jeton par rôle plutôt qu'un seul.
 */
function tokenFor(role) {
  let state;
  try {
    state = JSON.parse(readFileSync(join(HERE, '..', '.auth', `${role}.json`), 'utf8'));
  } catch {
    return null;
  }
  return (state.origins?.[0]?.localStorage ?? []).find((e) => e.name === 'token')?.value ?? null;
}

async function gql(query, token) {
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-run': '1', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  });
  const body = await resp.json().catch(() => ({}));
  return { data: body.data ?? null, errors: body.errors ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exécution
// ─────────────────────────────────────────────────────────────────────────────

const idOf = (c, prefix = PREFIX) => prefix + c.key;

/** Triplet + Stats des cycles clos + journal des retours. */
async function seedCase(db, refs, c, now, prefix = PREFIX) {
  const triple = buildDiTriple({ ...c, id: idOf(c, prefix), money: true }, refs, now);
  await writeTriple(db, triple);
  if (triple.extraStats?.length) await db.collection('stats').insertMany(triple.extraStats);
  if (triple.events?.length) {
    await db.collection('system_events').insertMany(triple.events.map((e) => ({ ...e })));
  }
  return triple;
}

/**
 * Vérifie UN cas : DI jetable → vraie mutation → relecture du statut → suppression.
 * Un cas `alsoVia` est rejoué avec l'AUTRE bouton : les deux doivent donner le même
 * statut, puisque le routage est serveur-autoritaire.
 */
async function verifyCase(db, refs, c, now, tokens) {
  if (!c.verify) return { ...c, mark: '✋', got: '(test manuel)' };
  const token = tokens[c.verify.as ?? 'ADMIN_MANAGER'];
  if (!token) {
    return { ...c, mark: '✋', got: `(jeton ${c.verify.as} absent)`, expect: c.verify.expect };
  }

  const run = async (fire) => {
    const id = idOf(c, VERIFY_PREFIX);
    await seedCase(db, refs, c, now, VERIFY_PREFIX);
    const r = await gql(fire(id), token);
    const di = await db.collection('dis').findOne({ _id: id }, { projection: { status: 1 } });
    await purgeSeed(db, id);
    return { status: di?.status, error: r.errors?.[0]?.message ?? null };
  };

  const first = await run(c.verify.fire);

  if (c.verify.expectError) {
    const ok = c.verify.expectError.test(first.error ?? '');
    return { ...c, mark: ok ? '✅' : '❌', got: ok ? 'refus attendu' : `pas de refus (statut=${first.status})`, expect: 'REFUS' };
  }

  let ok = first.status === c.verify.expect && !first.error;
  let got = first.status;
  let note = first.error ? ` ⚠ ${first.error}` : '';

  if (ok && c.verify.alsoVia) {
    const second = await run(c.verify.alsoVia);
    if (second.status !== c.verify.expect) {
      ok = false;
      got = `${first.status} mais l'autre bouton donne ${second.status}`;
      note = second.error ? ` ⚠ ${second.error}` : '';
    } else {
      got = `${first.status} (les 2 boutons)`;
    }
  }

  return { ...c, mark: ok ? '✅' : '❌', got: got + note, expect: c.verify.expect };
}

async function main() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(MONGO_DB);

  try {
    const groups = selectedGroups();
    const cases = groups.flatMap((g) => casesOf(g));

    // 1) PURGE — avant toute insertion : les index uniques stats{_idDi, ignoreCount}
    // et logsdis{_idDi, idIgnore} rejettent un re-seed. Avec `--only`, on ne purge
    // QUE les groupes reseedés : sinon les autres disparaîtraient sans être recréés.
    let purged;
    if (ONLY.length && !CLEAN) {
      purged = { dis: 0, stats: 0, logsdis: 0, notifications: 0 };
      for (const c of cases) {
        const n = await purgeSeed(db, idOf(c));
        for (const k of Object.keys(purged)) purged[k] += n[k] ?? 0;
      }
    } else {
      purged = await purgeSeed(db, PREFIX);
    }
    await purgeSeed(db, VERIFY_PREFIX);

    if (CLEAN) {
      console.log(
        `\nNettoyage (base ${MONGO_DB}) — DI : ${purged.dis}, stats : ${purged.stats}, `
        + `logs : ${purged.logsdis}, notifications : ${purged.notifications}.\n`,
      );
      return;
    }

    const refs = await resolveRefs(db);
    const now = new Date();

    console.log(`\nBase ${MONGO_DB} — comptes résolus : tech=${refs.techName}, `
      + `coordination=${refs.coordinatorName ?? '—'}, magasin=${refs.magasinName ?? '—'}, admin=${refs.adminName ?? '—'}.`);
    console.log(`  Purgé : ${purged.dis} DI précédentes.`);
    if (!refs.coordinatorName || !refs.magasinName) {
      console.log('  ⚠ Un rôle manque dans cette base : les écrans correspondants ne seront pas testables.');
    }

    // 2) VÉRIFICATION du routage sur des DI jetables.
    let results = [];
    const tokens = Object.fromEntries(
      ['ADMIN_MANAGER', 'TECH', 'COORDINATOR', 'MAGASIN'].map((r) => [r, tokenFor(r)]),
    );
    const token = tokens.ADMIN_MANAGER;
    if (NO_VERIFY) {
      console.log('  — vérification désactivée (--no-verify).');
    } else if (!token) {
      console.log('  ⚠ Aucun token dans qa/.auth/ADMIN_MANAGER.json — vérification sautée.'
        + ' Lance `npm run verify:auth` puis relance.');
    } else {
      const probe = await gql('{ __typename }', token).catch(() => ({ errors: [{ message: 'backend injoignable' }] }));
      if (probe.errors && !probe.data) {
        console.log(`  ⚠ Backend injoignable sur ${GRAPHQL_URL} (${probe.errors[0].message}) — vérification sautée.`);
      } else {
        for (const c of cases) results.push(await verifyCase(db, refs, c, now, tokens));
      }
    }

    // 3) RESEED du jeu final, propre.
    for (const c of cases) await seedCase(db, refs, c, now);

    // 4) RAPPORT.
    if (results.length) {
      console.log('\n════════ VÉRIFICATION DU ROUTAGE (chemin serveur réel) ════════');
      let failures = 0;
      for (const r of results) {
        if (r.mark === '❌') failures += 1;
        console.log(`  ${r.mark} ${r.idnum.padEnd(11)} ${r.title.slice(0, 62).padEnd(64)}`
          + `attendu=${String(r.expect ?? '—').padEnd(34)} obtenu=${r.got}`);
      }
      const checked = results.filter((r) => r.mark !== '✋').length;
      console.log(failures
        ? `\n  ❌ ${failures} flux sur ${checked} échouent (voir ci-dessus).`
        : `\n  ✅ ${checked}/${checked} — tous les flux vérifiables routent correctement.`);
    }

    const retours = cases.filter((c) => c.cycle > 0).length;
    console.log(`\n════════ JEU SEEDÉ — ${cases.length} DI dans ${MONGO_DB} `
      + `(${cases.length - retours} flux original, ${retours} retour) ════════`);
    for (const g of groups) {
      const [route, account] = GROUP_SCREEN[g];
      console.log(`\n──── GROUPE ${g} — ${GROUP_TITLES[g]}`);
      console.log(`     Écran : ${route}   ·   compte : ${account}`);
      for (const c of casesOf(g)) {
        console.log(`  ${c.idnum.padEnd(11)} ${c.status.padEnd(34)} ${c.title}`);
        console.log(`              ↳ ${c.next}`);
      }
    }
    console.log(`\nNettoyage : node scripts/seed-scenarios.mjs --clean\n`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error('ERREUR seed :', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
