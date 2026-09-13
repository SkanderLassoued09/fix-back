#!/usr/bin/env node
/**
 * JEU DE SCÉNARIOS DI — seed unique pour le test à la main.
 *
 * Pose UNE DI par scénario de diagnostic (flux original ET retour) et UNE DI par
 * poste de travail en aval (magasin, poignée de main composants, tarification,
 * approbation documentaire, réparation, clôture), puis PROUVE le routage en
 * tirant les vraies mutations GraphQL avant de reseeder un jeu propre.
 *
 * Remplace `seed-flow-test.js` (périmé : ignorait le découpage en 3 statuts de la
 * poignée de main composants et le split WAITING_DEVIS/WAITING_BC) et
 * `seed-retour-combos.mjs` (ids codés en dur, aucune vérification).
 *
 *   node scripts/seed-scenarios.mjs              # purge → vérifie → seed → rapport
 *   node scripts/seed-scenarios.mjs --clean      # purge seule
 *   node scripts/seed-scenarios.mjs --no-verify  # seed sans backend (:3000 éteint)
 *   node scripts/seed-scenarios.mjs --only=A,C   # limite à des groupes
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
//   changeStatusMagasinEstimation  di.service.ts:4230
//   changeStatusPending2           di.service.ts:4445
//   changeStatusTofinsh            di.service.ts:2778
//   shouldDetourMagasinExitForFixtronix  di.service.ts:4372
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
  // dans l'Approval). Le nom `Negociate1` est historique — la valeur produite est
  // bien WAITING_DEVIS depuis le split de l'ancien ATTENTE_BC_DEVIS.
  validerPrix: (id) => `mutation { changeStatusNegociate1(_id:"${id}") }`,
  negocier: (id) => `mutation { changeStatusNegociate2(_id:"${id}") }`,
  adminPending3: (id) => `mutation { managerAdminManager_Pending3(_id:"${id}") { _id status } }`,
  inDiagnostic: (id) => `mutation { changeStatusInDiagnostic(_id:"${id}") }`,
  inRepair: (id) => `mutation { changeStatusInRepair(_id:"${id}") }`,
  reactiver: (id) => `mutation { reactiverDi(diId:"${id}") { _id status } }`,
};

/** GROUPE A — entrée diagnostic technicien (INDIAGNOSTIC). */
const GROUP_A = [
  {
    key: 'A1', idnum: 'SC-A1', status: 'INDIAGNOSTIC', cycle: 0, rep: true, pdr: true,
    title: 'Original + réparable + PDR',
    next: '1) Tech : « Finir le diagnostic » → MagasinEstimation. 2) Magasin : « Terminer l\'estimation » → PENDING2. '
      + '3) Tarification → devis → BC → PENDING3 → réparation.',
    verify: { fire: M.magasinEstimation, expect: 'MagasinEstimation' },
  },
  {
    key: 'A2', idnum: 'SC-A2', status: 'INDIAGNOSTIC', cycle: 0, rep: true, pdr: true, comps: [],
    title: 'Original + PDR déclaré SANS composant (cas négatif)',
    next: 'Tech : cocher « contient des PDR » sans ajouter de composant → le SERVEUR DOIT REFUSER '
      + '(« PDR déclaré sans composant »). Aucune DI ne doit partir au magasin les mains vides.',
    verify: { fire: M.magasinEstimation, expectError: /PDR déclaré sans composant/ },
  },
  {
    key: 'A3', idnum: 'SC-A3', status: 'INDIAGNOSTIC', cycle: 0, rep: true, pdr: false, payant: true,
    title: 'Original + réparable + sans PDR + diagnostic PAYANT',
    next: '1) Tech : décocher « contient des PDR » → « Finir le diagnostic » → PENDING2 (magasin sauté). '
      + '2) Tarification : écran PRICING_DIAG, FINAL = prix_diagnostic − remise.',
    verify: { fire: M.pending2, expect: 'PENDING2' },
  },
  {
    key: 'A4', idnum: 'SC-A4', status: 'INDIAGNOSTIC', cycle: 0, rep: true, pdr: false, payant: false,
    title: 'Original + réparable + sans PDR + diagnostic NON PAYANT',
    next: '1) Tech : idem A3 → PENDING2. 2) Tarification : écran REPRIXÉ — on ne saisit QUE le prix '
      + 'de réparation, le serveur ajoute main-d\'œuvre + pièces (setRepairFinalPrice). C\'est LÀ que A3 et A4 divergent.',
    verify: { fire: M.pending2, expect: 'PENDING2' },
  },
  {
    key: 'A5', idnum: 'SC-A5', status: 'INDIAGNOSTIC', cycle: 0, rep: false, pdr: false, payant: true,
    title: 'Original + NON réparable + diagnostic PAYANT',
    next: '1) Tech : décocher « réparable » → « Terminer (non réparable) » → PENDING2 (on facture le diagnostic). '
      + '2) Admin : « Valider le prix » en tarification → IRREPARABLE facturé.',
    verify: { fire: M.toFinish, expect: 'PENDING2' },
  },
  {
    key: 'A6', idnum: 'SC-A6', status: 'INDIAGNOSTIC', cycle: 0, rep: false, pdr: false, payant: false,
    title: 'Original + NON réparable + diagnostic NON PAYANT',
    next: 'Tech : « Terminer (non réparable) » → IRREPARABLE immédiatement. Aucune facturation, '
      + 'aucun passage par PENDING2 ni tarification.',
    verify: { fire: M.toFinish, expect: 'IRREPARABLE' },
  },
  {
    key: 'A7', idnum: 'SC-A7', status: 'INDIAGNOSTIC', cycle: 1, fixtronix: false, rep: true, pdr: true,
    title: 'Retour + erreur CLIENT + réparable + PDR',
    next: '1) Tech : « Fin diagnostique retour » → MagasinEstimation. 2) Magasin : « Terminer l\'estimation » '
      + '→ PENDING2 → tarification. Erreur client : le client est bien facturé.',
    verify: { fire: M.magasinEstimation, expect: 'MagasinEstimation' },
  },
  {
    key: 'A8', idnum: 'SC-A8', status: 'INDIAGNOSTIC', cycle: 1, fixtronix: false, rep: true, pdr: false, payant: true,
    title: 'Retour + erreur CLIENT + réparable + sans PDR + payant',
    next: 'Tech : décocher PDR → « Fin diagnostique retour » → PENDING2. La tarification décide ensuite '
      + 'de facturer le diagnostic.',
    verify: { fire: M.pending2, expect: 'PENDING2', alsoVia: M.toFinish },
  },
  {
    key: 'A9', idnum: 'SC-A9', status: 'INDIAGNOSTIC', cycle: 1, fixtronix: false, rep: true, pdr: false, payant: false,
    title: 'Retour + erreur CLIENT + réparable + sans PDR + NON payant',
    next: 'Tech : idem A8 → PENDING2, mais l\'écran de tarification est le REPRIXÉ (diagnostic non facturé).',
    verify: { fire: M.pending2, expect: 'PENDING2', alsoVia: M.toFinish },
  },
  {
    key: 'A10', idnum: 'SC-A10', status: 'INDIAGNOSTIC', cycle: 1, fixtronix: false, rep: false, pdr: false,
    title: 'Retour + erreur CLIENT + NON réparable',
    next: 'Tech : décocher « réparable » → « Envoyer vers finir » → IRREPARABLE. '
      + 'En retour on ne REFACTURE pas, même si le diagnostic était payant.',
    verify: { fire: M.toFinish, expect: 'IRREPARABLE' },
  },
  {
    key: 'A11', idnum: 'SC-A11', status: 'INDIAGNOSTIC', cycle: 1, fixtronix: true, rep: true, pdr: true,
    title: 'Retour + erreur FIXTRONIX + réparable + PDR',
    next: '1) Tech : « Fin diagnostique retour » → MagasinEstimation. 2) Magasin : « Terminer l\'estimation » '
      + '→ CONFIRMATION (et NON PENDING2 — voir C3). RÈGLE : une erreur Fixtronix ne passe JAMAIS par la tarification.',
    verify: { fire: M.magasinEstimation, expect: 'MagasinEstimation' },
  },
  {
    key: 'A12', idnum: 'SC-A12', status: 'INDIAGNOSTIC', cycle: 1, fixtronix: true, rep: true, pdr: false,
    title: 'Retour + erreur FIXTRONIX + réparable + sans PDR',
    next: '1) Tech : décocher PDR → « Fin diagnostique retour » → PENDING3 DIRECT (magasin ET tarification sautés, '
      + 'non facturé). 2) Coordinatrice : joindre le devis puis envoyer en réparation. '
      + 'Les DEUX boutons retour doivent donner PENDING3 : le routage est serveur-autoritaire.',
    verify: { fire: M.pending2, expect: 'PENDING3', alsoVia: M.toFinish },
  },
  {
    key: 'A13', idnum: 'SC-A13', status: 'INDIAGNOSTIC', cycle: 1, fixtronix: true, rep: false, pdr: false,
    title: 'Retour + erreur FIXTRONIX + NON réparable',
    next: 'Tech : décocher « réparable » → « Envoyer vers finir » → IRREPARABLE, AUCUNE facturation. '
      + 'Les pièces gaspillées par notre faute ne sont jamais refacturées au client.',
    verify: { fire: M.toFinish, expect: 'IRREPARABLE' },
  },
  {
    key: 'A14', idnum: 'SC-A14', status: 'INDIAGNOSTIC', cycle: 1, fixtronix: null, rep: true, pdr: false,
    title: 'Retour SANS verdict pré-saisi — coche « Erreur Fixtronix » toi-même',
    next: 'C\'est l\'état RÉEL d\'un retour avant que le tech ne tranche (ni la DI ni le log ne portent le verdict). '
      + '1) Ouvrir le diagnostic → étape Validation → COCHER « Erreur Fixtronix », décocher PDR → '
      + '« Fin diagnostique retour » → doit donner PENDING3 (jamais PENDING2/tarification). '
      + '2) Bonus : mettre en PAUSE après avoir coché, rouvrir, finir → le verdict doit SURVIVRE (collant sur le cycle).',
    // Tout l'intérêt du cas est le GESTE du technicien. Le tirer par l'API sans ce
    // geste donnerait PENDING2 — correct (aucune erreur déclarée) mais afficherait
    // un ❌ trompeur. Amorcé, pas auto-vérifié.
    verify: null,
  },
  {
    key: 'A15', idnum: 'SC-A15', status: 'INDIAGNOSTIC', cycle: 2, fixtronix: true, rep: true, pdr: false,
    title: 'Retour CYCLE 2 + erreur FIXTRONIX + réparable + sans PDR',
    next: 'Même attendu qu\'A12 (PENDING3) : le cycle 2 se comporte comme le cycle 1. '
      + 'Vérifie que le verdict est lu sur le log du cycle COURANT (idIgnore=2) et non sur un cycle antérieur.',
    verify: { fire: M.pending2, expect: 'PENDING3', alsoVia: M.toFinish },
  },
];

/** GROUPE B — amont du diagnostic. */
const GROUP_B = [
  {
    key: 'B1', idnum: 'SC-B1', status: 'CREATED', cycle: 0, rep: true, pdr: false, role: 'Manager',
    title: 'Créée par le manager, pas encore envoyée',
    next: 'Manager / Admin : envoyer au coordinateur → PENDING1.',
    verify: { fire: M.pending1, expect: 'PENDING1' },
  },
  {
    key: 'B2', idnum: 'SC-B2', status: 'PENDING1', cycle: 0, rep: true, pdr: false, role: 'Coordinator',
    title: 'Chez la coordinatrice, à affecter au diagnostic',
    next: 'Coordinatrice : affecter un technicien → DIAGNOSTIC.',
    verify: { fire: M.coordToDiag, expect: 'DIAGNOSTIC' },
  },
  {
    key: 'B3', idnum: 'SC-B3', status: 'DIAGNOSTIC', cycle: 0, rep: true, pdr: false,
    title: 'Affectée au technicien, diagnostic pas encore ouvert',
    next: 'Tech : ouvrir la loupe → passe en INDIAGNOSTIC et le chrono démarre.',
    verify: { fire: M.inDiagnostic, expect: 'INDIAGNOSTIC', as: 'TECH' },
  },
  {
    key: 'B4', idnum: 'SC-B4', status: 'DIAGNOSTIC_Pause', cycle: 0, rep: true, pdr: false,
    title: 'Diagnostic EN PAUSE — reprise',
    next: 'Tech : le libellé du bouton vient du STATUT, pas du chrono. Reprendre → INDIAGNOSTIC, '
      + 'sans rechargement de la liste (sinon double-clic + scintillement).',
    verify: { fire: M.inDiagnostic, expect: 'INDIAGNOSTIC', as: 'TECH' },
  },
];

/** GROUPE C — magasin et poignée de main composants. */
const GROUP_C = [
  {
    key: 'C1', idnum: 'SC-C1', status: 'MagasinEstimation', cycle: 0, rep: true, pdr: true, role: 'Magasin',
    title: 'Sortie magasin — flux original + PDR',
    next: 'Magasin : « Terminer l\'estimation » → PENDING2 → tarification normale.',
    verify: { fire: M.pending2, expect: 'PENDING2' },
  },
  {
    key: 'C2', idnum: 'SC-C2', status: 'MagasinEstimation', cycle: 1, fixtronix: false, rep: true, pdr: true, role: 'Magasin',
    title: 'Sortie magasin — retour erreur CLIENT + PDR',
    next: 'Magasin : « Terminer l\'estimation » → PENDING2. Non-régression : le client reste facturé.',
    verify: { fire: M.pending2, expect: 'PENDING2' },
  },
  {
    key: 'C3', idnum: 'SC-C3', status: 'MagasinEstimation', cycle: 1, fixtronix: true, rep: true, pdr: true, role: 'Magasin',
    title: 'Sortie magasin — retour erreur FIXTRONIX + PDR (détour)',
    next: 'Magasin : « Terminer l\'estimation » → CONFIRMATION, et NON PENDING2. La DI ne doit JAMAIS '
      + 'toucher PENDING2 ni PRICING_DIAG. Puis : envoi coordination → confirmation → « Terminer les composants » → PENDING3.',
    verify: { fire: M.pending2, expect: 'CONFIRMATION' },
  },
  {
    key: 'C4', idnum: 'SC-C4', status: 'CONFIRMATION', cycle: 0, rep: true, pdr: true, role: 'Magasin',
    title: 'Poignée de main 1/3 — le magasin prépare la liste',
    next: 'Magasin : « Envoyer au coordinateur » → ATTENTE_CONFIRMATION_COORDINATION.',
    verify: { fire: M.sendToCoord, expect: 'ATTENTE_CONFIRMATION_COORDINATION' },
  },
  {
    key: 'C5', idnum: 'SC-C5', status: 'ATTENTE_CONFIRMATION_COORDINATION', cycle: 0, rep: true, pdr: true, role: 'Coordinator',
    title: 'Poignée de main 2/3 — attente de la coordinatrice',
    next: 'Coordinatrice : « Confirmer les composants » → MAGASIN_FINALISATION (la DI repart au magasin).',
    verify: { fire: M.coordConfirm, expect: 'MAGASIN_FINALISATION' },
  },
  {
    key: 'C6', idnum: 'SC-C6', status: 'MAGASIN_FINALISATION', cycle: 0, rep: true, pdr: true, role: 'Magasin',
    title: 'Poignée de main 3/3 — finalisation magasin',
    next: 'Magasin : « Terminer les composants » → PENDING3. Le stock est décrémenté UNE SEULE FOIS '
      + '(garde à gagnant unique sur componentsConfirmedAt).',
    verify: { fire: M.pending3, expect: 'PENDING3' },
  },
];

/** GROUPE D — tarification et approbation documentaire. */
const GROUP_D = [
  {
    key: 'D1', idnum: 'SC-D1', status: 'PENDING2', cycle: 0, rep: true, pdr: false, payant: true, role: 'Coordinator',
    title: 'Chez la coordinatrice, à envoyer en tarification',
    next: 'Coordinatrice : envoyer aux admins pour tarification → PRICING_DIAG.',
    verify: { fire: M.pricing, expect: 'PRICING_DIAG' },
  },
  {
    key: 'D2', idnum: 'SC-D2', status: 'PRICING_DIAG', cycle: 0, rep: true, pdr: false, payant: true, role: 'Admin_Manager',
    title: 'Tarification — réparable + diagnostic PAYANT',
    next: 'Admin : saisir le coût réel du diagnostic (borné 150–500 DT) + l\'estimation de réparation, '
      + 'puis « Valider le prix » → WAITING_DEVIS.',
    verify: { fire: M.validerPrix, expect: 'WAITING_DEVIS' },
  },
  {
    key: 'D3', idnum: 'SC-D3', status: 'PRICING_DIAG', cycle: 0, rep: true, pdr: false, payant: false, role: 'Admin_Manager',
    title: 'Tarification — réparable + diagnostic NON PAYANT (écran reprixé)',
    next: 'Admin : on ne saisit QUE le « prix réparation » ; le serveur calcule '
      + 'FINAL = prix_réparation + main-d\'œuvre diagnostic + pièces (setRepairFinalPrice, serveur-autoritaire).',
    verify: { fire: M.validerPrix, expect: 'WAITING_DEVIS' },
  },
  {
    key: 'D4', idnum: 'SC-D4', status: 'PRICING_DIAG', cycle: 0, rep: false, pdr: false, payant: true, role: 'Admin_Manager',
    title: 'Tarification — NON réparable + PAYANT (suite d\'A5)',
    next: 'Admin : « Valider le prix » → IRREPARABLE facturé (et non WAITING_DEVIS) : on facture le '
      + 'diagnostic d\'un équipement irréparable.',
    verify: { fire: M.irreparableFromPricing, expect: 'IRREPARABLE' },
  },
  {
    key: 'D5', idnum: 'SC-D5', status: 'WAITING_DEVIS', cycle: 0, rep: true, pdr: false, role: 'Manager',
    title: 'Approbation 1/2 — attente du devis signé',
    next: 'Téléverser le devis → WAITING_BC automatiquement (aucune décision métier). '
      + 'Échappatoires : négocier → NEGOTIATION2, annuler → ANNULER.',
    verify: { fire: M.negocier, expect: 'NEGOTIATION2' },
  },
  {
    key: 'D6', idnum: 'SC-D6', status: 'WAITING_BC', cycle: 0, rep: true, pdr: false, role: 'Manager',
    title: 'Approbation 2/2 — attente du bon de commande (sans composants)',
    next: 'Téléverser le BC → même logique que « Confirmer » : sans composants → PENDING3 ; '
      + 'avec composants → CONFIRMATION ; non réparable → IRREPARABLE.',
    verify: { fire: M.pending3, expect: 'PENDING3' },
  },
  {
    key: 'D7', idnum: 'SC-D7', status: 'NEGOTIATION2', cycle: 0, rep: true, pdr: false, role: 'Admin_Manager',
    title: 'Négociation (remise 20–25 % ou changement de prix)',
    next: 'Admin : conclure → PENDING3, ou abandonner → ANNULER.',
    verify: { fire: M.adminPending3, expect: 'PENDING3' },
  },
];

/** GROUPE E — réparation et clôture. */
const GROUP_E = [
  {
    key: 'E1', idnum: 'SC-E1', status: 'PENDING3', cycle: 0, rep: true, pdr: false, role: 'Coordinator',
    title: 'Prête pour la réparation (flux normal)',
    next: 'Coordinatrice : affecter le technicien réparateur → REPARATION.',
    verify: { fire: M.repaire, expect: 'REPARATION' },
  },
  {
    key: 'E2', idnum: 'SC-E2', status: 'PENDING3', cycle: 1, fixtronix: true, rep: true, pdr: false, role: 'Coordinator',
    title: 'Prête pour la réparation — raccourci retour Fixtronix (devis OBLIGATOIRE)',
    next: 'Suite d\'A12 : `needsDevisBeforeRepair` est posé. La coordinatrice doit JOINDRE LE DEVIS '
      + 'au moment d\'envoyer en réparation (coordinatorSendToRepairWithDevis) — un seul geste. Non facturé.',
    extra: { needsDevisBeforeRepair: true },
    verify: null,
  },
  {
    key: 'E3', idnum: 'SC-E3', status: 'REPARATION', cycle: 0, rep: true, pdr: false,
    title: 'Affectée en réparation, pas encore ouverte',
    next: 'Tech : ouvrir → INREPARATION, le chrono de réparation démarre.',
    verify: { fire: M.inRepair, expect: 'INREPARATION', as: 'TECH' },
  },
  {
    key: 'E4', idnum: 'SC-E4', status: 'INREPARATION', cycle: 0, rep: true, pdr: false,
    title: 'Réparation en cours',
    next: 'Tech : « Terminer la réparation » → WAITING_BL. La DI SORT alors de la vue technicien '
      + '(le BL est téléversé par la coordination).',
    verify: { fire: M.toFinish, expect: 'WAITING_BL' },
  },
  {
    key: 'E5', idnum: 'SC-E5', status: 'WAITING_BL', cycle: 0, rep: true, pdr: false, role: 'Manager',
    title: 'Clôture 1/2 — attente du bon de livraison',
    next: 'La relance « BL à téléverser » bat dans le centre de notifications. '
      + 'Téléverser le BL → WAITING_FACTURE. Vérifier que la DI n\'est PLUS dans la liste technicien.',
    verify: null,
  },
  {
    key: 'E6', idnum: 'SC-E6', status: 'WAITING_FACTURE', cycle: 0, rep: true, pdr: false, role: 'Manager',
    title: 'Clôture 2/2 — attente de la facture',
    next: 'Téléverser la facture → FINISHED, avec UNE SEULE notification finale.',
    verify: null,
  },
  {
    key: 'E8', idnum: 'SC-E8', status: 'WAITING_FACTURE', cycle: 1, fixtronix: false, rep: true, pdr: false, role: 'Manager',
    title: 'Retour en clôture — modale « Affectation des Fichiers »',
    next: 'Bouton trombone → la modale doit séparer les cycles : « Fichiers principaux » = les 4 documents du '
      + 'FLUX D\'ORIGINE (URLs en `-c0`), « Historique des retours » = le seul Retour N°1 (URLs en `-c1`). '
      + 'Aucun « Retour N°0 », et aucun document du retour dans le bloc principal.',
    verify: null,
  },
  {
    key: 'E7', idnum: 'SC-E7', status: 'FINISHED', cycle: 0, rep: true, pdr: false, role: 'Manager',
    title: 'Terminée — point de départ d\'un RETOUR',
    next: 'Ouvrir un retour → RETOUR1 : `ignoreCount` passe à 1, le cycle 0 est CLOS, le miroir de la DI '
      + 'est remis à zéro (verdict, documents, prix) et un nouveau dossier de cycle est ouvert.',
    verify: { fire: M.retour, expect: 'RETOUR1' },
  },
];

/** GROUPE F — terminaux. */
const GROUP_F = [
  {
    key: 'F1', idnum: 'SC-F1', status: 'IRREPARABLE', cycle: 0, rep: false, pdr: false, payant: false, role: 'Manager',
    title: 'Équipement irréparable — clôturé',
    next: 'Statut TERMINAL : aucune transition sortante. Doit être hors des listes Tech / Magasin / Coordination.',
    verify: null,
  },
  {
    key: 'F2', idnum: 'SC-F2', status: 'ANNULER', cycle: 0, rep: true, pdr: false, role: 'Manager',
    title: 'Annulée — réactivable une fois',
    next: 'Coordinatrice / Admin : « Réactiver » → retour au statut précédent lu dans statusHistory. '
      + 'Refusé si BL/facture déjà émis, ou si déjà réactivée une fois. Rôle TECH exclu.',
    verify: { fire: M.reactiver, expect: 'PENDING2' },
  },
];

const GROUPS = { A: GROUP_A, B: GROUP_B, C: GROUP_C, D: GROUP_D, E: GROUP_E, F: GROUP_F };
const GROUP_TITLES = {
  A: 'Entrée diagnostic technicien — INDIAGNOSTIC',
  B: 'Amont du diagnostic',
  C: 'Magasin et poignée de main composants',
  D: 'Tarification et approbation documentaire',
  E: 'Réparation et clôture',
  F: 'Terminaux',
};
/** Écran où se joue chaque groupe, pour le plan de test final. */
const GROUP_SCREEN = {
  A: ['/tickets/ticket/tech-di-list', 'tech'],
  B: ['/tickets/ticket/ticket-list puis coordinator-di-list', 'skander / coordinatrice'],
  C: ['/tickets/ticket/magasin-di-list (+ coordinator-di-list pour C5)', 'magasin / coordinatrice'],
  D: ['/tickets/ticket/ticket-list', 'skander (admin)'],
  E: ['/tickets/ticket/coordinator-di-list puis tech-di-list', 'coordinatrice / tech'],
  F: ['/tickets/ticket/ticket-list', 'skander (admin)'],
};

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

async function seedCase(db, refs, c, now, prefix = PREFIX) {
  const triple = buildDiTriple({ ...c, id: idOf(c, prefix) }, refs, now);
  await writeTriple(db, triple);
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
    const cases = groups.flatMap((g) => GROUPS[g].map((c) => ({ ...c, group: g })));

    // 1) PURGE — toujours, et avant toute insertion : les index uniques
    // stats{_idDi, ignoreCount} et logsdis{_idDi, idIgnore} rejettent un re-seed.
    const purged = await purgeSeed(db, PREFIX);
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
        console.log(`  ${r.mark} ${r.idnum.padEnd(7)} ${r.title.slice(0, 54).padEnd(56)}`
          + `attendu=${String(r.expect ?? '—').padEnd(34)} obtenu=${r.got}`);
      }
      const checked = results.filter((r) => r.mark !== '✋').length;
      console.log(failures
        ? `\n  ❌ ${failures} flux sur ${checked} échouent (voir ci-dessus).`
        : `\n  ✅ ${checked}/${checked} — tous les flux vérifiables routent correctement.`);
    }

    console.log(`\n════════ JEU SEEDÉ — ${cases.length} DI dans ${MONGO_DB} ════════`);
    for (const g of groups) {
      const [route, account] = GROUP_SCREEN[g];
      console.log(`\n──── GROUPE ${g} — ${GROUP_TITLES[g]}`);
      console.log(`     Écran : ${route}   ·   compte : ${account}`);
      for (const c of GROUPS[g]) {
        console.log(`  ${c.idnum.padEnd(7)} ${c.title}`);
        console.log(`          ↳ ${c.next}`);
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
