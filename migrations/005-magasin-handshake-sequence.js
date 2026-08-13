/**
 * Migration 005 — Handshake magasin↔coordination : statut unique → séquence.
 *
 * Le point de confirmation des composants, jusqu'ici porté par des FLAGS
 * (`isSentToCoordinator`, `isConfirmedComponentFromCoordinator`,
 * `handleSendingNotificationBetweenCoordinatorAndMagasin`, string `gotComposantFromMagasin`),
 * devient une SÉQUENCE DE STATUTS explicites :
 *
 *   INMAGASIN                         → MAGASIN_PREPARATION            (étape 1)
 *   CONFIRMATION_COMPOSANTS /         → ATTENTE_CONFIRMATION_COORDINATION (étape 2)
 *   ATTENTE_CONFIRMATION_COORDINATION   si isConfirmedComponentFromCoordinator = false
 *                                     → MAGASIN_FINALISATION           (étape 3)
 *                                       si isConfirmedComponentFromCoordinator = true
 *   + normalise `gotComposantFromMagasin` string "false"/"true" → booléen.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul, AUCUNE écriture.
 * Idempotent. Run (rapport) :
 *   mongosh "mongodb://localhost:27017/<DB>" migrations/005-magasin-handshake-sequence.js
 */
const DRY_RUN = true;

print('== Migration 005: handshake magasin↔coordination → séquence ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

const dis = db.getCollection('dis');
const AWAIT = ['ATTENTE_CONFIRMATION_COORDINATION', 'CONFIRMATION_COMPOSANTS'];

// ── 1. INMAGASIN → MAGASIN_PREPARATION (dis + stats + logsdis) ──────────────
for (const name of ['dis', 'stats', 'logsdis']) {
  const col = db.getCollection(name);
  const n = col.countDocuments({ status: 'INMAGASIN' });
  print(`  ${name}: INMAGASIN → MAGASIN_PREPARATION : ${n}`);
  if (!DRY_RUN && n > 0)
    col.updateMany(
      { status: 'INMAGASIN' },
      { $set: { status: 'MAGASIN_PREPARATION' } },
    );
}

// ── 2. Confirmation composants : split par le flag confirm (dis) ────────────
const toFinalisation = dis.countDocuments({
  status: { $in: AWAIT },
  isConfirmedComponentFromCoordinator: true,
});
const toAwaiting = dis.countDocuments({
  status: { $in: AWAIT },
  isConfirmedComponentFromCoordinator: { $ne: true },
});
print(`  dis: confirmé=true  → MAGASIN_FINALISATION            : ${toFinalisation}`);
print(`  dis: confirmé=false → ATTENTE_CONFIRMATION_COORDINATION : ${toAwaiting}`);
if (!DRY_RUN) {
  if (toFinalisation > 0)
    dis.updateMany(
      { status: { $in: AWAIT }, isConfirmedComponentFromCoordinator: true },
      { $set: { status: 'MAGASIN_FINALISATION' } },
    );
  if (toAwaiting > 0)
    dis.updateMany(
      { status: { $in: AWAIT }, isConfirmedComponentFromCoordinator: { $ne: true } },
      { $set: { status: 'ATTENTE_CONFIRMATION_COORDINATION' } },
    );
}

// ── 3. gotComposantFromMagasin string → booléen (dis + logsdis) ─────────────
for (const name of ['dis', 'logsdis']) {
  const col = db.getCollection(name);
  const strTrue = col.countDocuments({ gotComposantFromMagasin: 'true' });
  const strFalse = col.countDocuments({ gotComposantFromMagasin: 'false' });
  print(`  ${name}: gotComposantFromMagasin string→bool : "true"=${strTrue} "false"=${strFalse}`);
  if (!DRY_RUN) {
    if (strTrue > 0)
      col.updateMany({ gotComposantFromMagasin: 'true' }, { $set: { gotComposantFromMagasin: true } });
    if (strFalse > 0)
      col.updateMany({ gotComposantFromMagasin: 'false' }, { $set: { gotComposantFromMagasin: false } });
  }
}

print(DRY_RUN ? '-- FIN (dry run). --' : '-- FIN (appliqué). --');
