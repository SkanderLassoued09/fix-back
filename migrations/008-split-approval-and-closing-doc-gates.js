/**
 * Migration 008 — SPLIT documentaire des phases Approval et Clôture.
 *
 *   ATTENTE_BC_DEVIS / NEGOTIATION1 (legacy)  →  WAITING_DEVIS | WAITING_BC
 *   CLOSING          / ATTENTE_BL_FACTURE      →  WAITING_BL    | WAITING_FACTURE
 *
 * PRINCIPE (décidé) : la migration **TRADUIT des valeurs**, elle ne déclenche
 * AUCUNE transition métier. On classe chaque DI VIVE selon les documents DÉJÀ
 * présents (le statut « d'entrée » si le doc attendu manque) :
 *   - Approval : devis absent → WAITING_DEVIS ; devis présent → WAITING_BC.
 *   - Clôture  : BL absent → WAITING_BL ; BL présent → WAITING_FACTURE.
 *   - Une DI Approval avec devis+BC déjà présents → WAITING_BC (PAS d'auto-
 *     avance : le manager garde la main). Listée dans le rapport.
 *   - Une DI Clôture avec BL+facture déjà présents → WAITING_FACTURE (0 cas
 *     attendu). À faire passer ENSUITE par le helper `maybeAdvanceDocGate` (via
 *     l'appli) pour clôturer avec notifications/sync — JAMAIS FINISHED en dur ici.
 *   - DI en RETOUR (ignoreCount>0) : documents dans `logsdis`. Classées via le
 *     log correspondant si lisible ; sinon défaut prudent (WAITING_DEVIS /
 *     WAITING_BL) et **listées par référence** pour correction manuelle.
 *
 * `statusHistory` : les entrées legacy sont réécrites vers le statut d'ENTRÉE de
 * la phase (ATTENTE_BC_DEVIS/NEGOTIATION1 → WAITING_DEVIS ; CLOSING/ATTENTE_BL_
 * FACTURE → WAITING_BL) — pas d'info par-entrée sur les documents.
 *
 * `stats` / `logsdis` (champ `status` miroir de `dis.status`) : alignés sur le
 * NOUVEAU statut courant de la DI correspondante (jointure par `_idDi`).
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul, AUCUNE écriture. Idempotent.
 * Run (rapport) :
 *   mongosh "mongodb://localhost:27017/<DB>" migrations/008-split-approval-and-closing-doc-gates.js
 * NB : chaque poste a SA base (localhost en dur) — lancer sur chacune.
 */
const DRY_RUN = true;

print('== Migration 008: split Approval + Clôture (doc gates) ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

const APPROVAL_LEGACY = ['ATTENTE_BC_DEVIS', 'NEGOTIATION1'];
const CLOSING_LEGACY = ['CLOSING', 'ATTENTE_BL_FACTURE'];

function isRef(v) {
  return v && typeof v === 'object' && !!v.driveFileId;
}
// Document présent = DriveDocRef (driveDocs.X) OU ancien champ string.
function docPresent(di, driveKey, legacyField) {
  const dd = di.driveDocs || {};
  return isRef(dd[driveKey]) || (di[legacyField] != null && di[legacyField] !== '');
}
// Pour une DI en retour : lire le log de son cycle courant.
function retourLog(di) {
  return db.logsdis.findOne({ _idDi: di._id, idIgnore: di.ignoreCount });
}
function retourDocPresent(log, legacyField, driveKey) {
  if (!log) return null; // indéterminé
  const dd = log.driveDocs || {};
  if (isRef(dd[driveKey])) return true;
  return log[legacyField] != null && log[legacyField] !== '';
}

const diNewStatus = {}; // _id -> nouveau statut courant (pour stats/logsdis)
const manualReview = []; // DI retour non classables de façon fiable

// ── 1. Classement + traduction des DI VIVES ────────────────────────────────
const buckets = {
  WAITING_DEVIS: 0,
  WAITING_BC: 0,
  WAITING_BL: 0,
  WAITING_FACTURE: 0,
};
let approvalWithBothDocs = 0;
let closingWithBothDocs = [];

// -- Approval --
db.dis.find({ status: { $in: APPROVAL_LEGACY } }).forEach((di) => {
  let target;
  if (di.ignoreCount && di.ignoreCount > 0) {
    const log = retourLog(di);
    const devis = retourDocPresent(log, 'devis', 'Devis');
    if (devis === null) {
      target = 'WAITING_DEVIS';
      manualReview.push({ _id: di._id, _idnum: di._idnum, phase: 'approval', reason: 'retour: log illisible' });
    } else target = devis ? 'WAITING_BC' : 'WAITING_DEVIS';
  } else {
    const devis = docPresent(di, 'Devis', 'devis');
    const bc = docPresent(di, 'BC', 'bon_de_commande');
    target = devis ? 'WAITING_BC' : 'WAITING_DEVIS';
    if (devis && bc) approvalWithBothDocs++;
  }
  diNewStatus[di._id] = target;
  buckets[target]++;
});

// -- Clôture --
db.dis.find({ status: { $in: CLOSING_LEGACY } }).forEach((di) => {
  let target;
  if (di.ignoreCount && di.ignoreCount > 0) {
    const log = retourLog(di);
    const bl = retourDocPresent(log, 'bon_de_livraison', 'BL');
    if (bl === null) {
      target = 'WAITING_BL';
      manualReview.push({ _id: di._id, _idnum: di._idnum, phase: 'closing', reason: 'retour: log illisible' });
    } else target = bl ? 'WAITING_FACTURE' : 'WAITING_BL';
  } else {
    const bl = docPresent(di, 'BL', 'bon_de_livraison');
    const facture = docPresent(di, 'Facture', 'facture');
    target = bl ? 'WAITING_FACTURE' : 'WAITING_BL';
    if (bl && facture) closingWithBothDocs.push({ _id: di._id, _idnum: di._idnum });
  }
  diNewStatus[di._id] = target;
  buckets[target]++;
});

print('--- Classement des DI vives (par documents présents) ---');
print('  Approval → WAITING_DEVIS (devis absent) : ' + buckets.WAITING_DEVIS);
print('  Approval → WAITING_BC    (devis présent) : ' + buckets.WAITING_BC +
      '   (dont devis+BC déjà présents, NON auto-avancées : ' + approvalWithBothDocs + ')');
print('  Clôture  → WAITING_BL      (BL absent) : ' + buckets.WAITING_BL);
print('  Clôture  → WAITING_FACTURE (BL présent) : ' + buckets.WAITING_FACTURE);
if (closingWithBothDocs.length) {
  print('  ⚠ Clôture avec BL+facture déjà présents → WAITING_FACTURE puis à passer');
  print('    par maybeAdvanceDocGate (appli) pour FINISHED. Références :');
  closingWithBothDocs.forEach((d) => print('      - ' + d._id + ' (#' + d._idnum + ')'));
}
if (manualReview.length) {
  print('  ⚠ DI retour non classables de façon fiable (défaut prudent, à revoir) :');
  manualReview.forEach((d) => print('      - ' + d._id + ' (#' + d._idnum + ') [' + d.phase + '] ' + d.reason));
}

// Application dis
if (!DRY_RUN) {
  Object.keys(diNewStatus).forEach((id) => {
    db.dis.updateOne({ _id: id }, { $set: { status: diNewStatus[id] } });
  });
}

// ── 2. statusHistory : legacy → statut d'ENTRÉE de la phase ─────────────────
const histApproval = db.dis.countDocuments({ 'statusHistory.status': { $in: APPROVAL_LEGACY } });
const histClosing = db.dis.countDocuments({ 'statusHistory.status': { $in: CLOSING_LEGACY } });
print('--- statusHistory (réécriture legacy → statut d\'entrée) ---');
print('  DI avec entrée Approval legacy → WAITING_DEVIS : ' + histApproval);
print('  DI avec entrée Clôture  legacy → WAITING_BL    : ' + histClosing);
if (!DRY_RUN) {
  db.dis.updateMany(
    { 'statusHistory.status': { $in: APPROVAL_LEGACY } },
    { $set: { 'statusHistory.$[e].status': 'WAITING_DEVIS' } },
    { arrayFilters: [{ 'e.status': { $in: APPROVAL_LEGACY } }] },
  );
  db.dis.updateMany(
    { 'statusHistory.status': { $in: CLOSING_LEGACY } },
    { $set: { 'statusHistory.$[e].status': 'WAITING_BL' } },
    { arrayFilters: [{ 'e.status': { $in: CLOSING_LEGACY } }] },
  );
}

// ── 3. stats + logsdis : aligner sur le NOUVEAU statut courant de la DI ─────
print('--- stats / logsdis (champ status, aligné sur la DI) ---');
for (const name of ['stats', 'logsdis']) {
  const col = db.getCollection(name);
  let n = 0;
  col
    .find({ status: { $in: APPROVAL_LEGACY.concat(CLOSING_LEGACY) } })
    .forEach((row) => {
      const target = diNewStatus[row._idDi];
      if (!target) return; // DI hors phase split → laisser tel quel
      n++;
      if (!DRY_RUN) col.updateOne({ _id: row._id }, { $set: { status: target } });
    });
  print('  ' + name + '.status legacy alignés : ' + n);
}

// ── Rapport final ──────────────────────────────────────────────────────────
print('--- ÉTAT APRÈS (ou attendu en dry-run) ---');
[
  'WAITING_DEVIS',
  'WAITING_BC',
  'WAITING_BL',
  'WAITING_FACTURE',
].forEach((s) => print('  dis en ' + s + ' : ' + (DRY_RUN ? buckets[s] + ' (prévu)' : db.dis.countDocuments({ status: s }))));
print('  dis restant en legacy Approval : ' + db.dis.countDocuments({ status: { $in: APPROVAL_LEGACY } }));
print('  dis restant en legacy Clôture  : ' + db.dis.countDocuments({ status: { $in: CLOSING_LEGACY } }));
print(DRY_RUN ? '-- FIN (dry run). --' : '-- FIN (appliqué). --');
