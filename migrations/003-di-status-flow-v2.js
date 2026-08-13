/**
 * Migration 003 — DI status flow v2.
 *
 * 1. Renomme les valeurs de statut :
 *      NEGOTIATION1            → ATTENTE_BC_DEVIS
 *      CONFIRMATION_COMPOSANTS → ATTENTE_CONFIRMATION_COORDINATION
 *    (dans `dis.status`, `stats.status` et les `logsdis`).
 * 2. Normalise `gotComposantFromMagasin` : STRING "false"/"true" → BOOLEAN
 *    (le champ était typé string avec un défaut cassé — 56/104 DI portaient la
 *    string "false", truthy en JS).
 *
 * NE rétrograde AUCUNE DI FINISHED. N'introduit PAS ATTENTE_BL_FACTURE sur des
 * DI existantes (0 en INREPARATION au moment de l'écriture) — le nouveau statut
 * ne s'applique qu'au flux post-déploiement.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul, AUCUNE écriture.
 * Passer à false (ci-dessous) pour appliquer. Idempotent (ré-exécution = no-op).
 *
 * Run (rapport) :
 *   mongosh "mongodb://localhost:27017/fixtronix" migrations/003-di-status-flow-v2.js
 * NB : chaque poste a SA base (localhost en dur) — lancer sur chacune.
 */
const DRY_RUN = true;

print('== Migration 003: DI status flow v2 ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

const STATUS_RENAMES = [
  { from: 'NEGOTIATION1', to: 'ATTENTE_BC_DEVIS' },
  { from: 'CONFIRMATION_COMPOSANTS', to: 'ATTENTE_CONFIRMATION_COORDINATION' },
];

// ── 1. Status renames (dis + stats + logsdis) ──────────────────────────────
const statusCollections = ['dis', 'stats', 'logsdis'];
for (const { from, to } of STATUS_RENAMES) {
  for (const name of statusCollections) {
    const col = db.getCollection(name);
    if (!col) continue;
    const count = col.countDocuments({ status: from });
    print(`  ${name}.status ${from} → ${to} : ${count}`);
    if (!DRY_RUN && count > 0) {
      const res = col.updateMany({ status: from }, { $set: { status: to } });
      print(`     appliqué : ${res.modifiedCount}`);
    }
  }
}

// ── 2. gotComposantFromMagasin string → boolean (dis + logsdis) ─────────────
for (const name of ['dis', 'logsdis']) {
  const col = db.getCollection(name);
  if (!col) continue;
  const strTrue = col.countDocuments({ gotComposantFromMagasin: 'true' });
  const strFalse = col.countDocuments({ gotComposantFromMagasin: 'false' });
  print(
    `  ${name}.gotComposantFromMagasin string→bool : "true"=${strTrue} "false"=${strFalse}`,
  );
  if (!DRY_RUN) {
    if (strTrue > 0)
      col.updateMany(
        { gotComposantFromMagasin: 'true' },
        { $set: { gotComposantFromMagasin: true } },
      );
    if (strFalse > 0)
      col.updateMany(
        { gotComposantFromMagasin: 'false' },
        { $set: { gotComposantFromMagasin: false } },
      );
  }
}

// ── Rapport ────────────────────────────────────────────────────────────────
print('--- ÉTAT APRÈS (ou attendu en dry-run) ---');
print('  dis restant en NEGOTIATION1 : ' + db.dis.countDocuments({ status: 'NEGOTIATION1' }));
print('  dis en ATTENTE_BC_DEVIS : ' + db.dis.countDocuments({ status: 'ATTENTE_BC_DEVIS' }));
print('  dis FINISHED (inchangées) : ' + db.dis.countDocuments({ status: 'FINISHED' }));
print(
  '  dis gotComposantFromMagasin encore string : ' +
    db.dis.countDocuments({ gotComposantFromMagasin: { $type: 'string' } }),
);
