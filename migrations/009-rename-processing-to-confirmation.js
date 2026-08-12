/**
 * Migration 009 — Renommage du statut préparation magasin : PROCESSING → CONFIRMATION.
 *
 * La CLÉ TS `InMagasin` est conservée — seule la VALEUR stockée change
 * (MAGASIN_PREPARATION → PROCESSING → CONFIRMATION). Renomme la valeur dans les
 * collections dont le `status` est synchronisé avec `Di.status` (`dis`, `stats`,
 * `logsdis`) ET dans les entrées `statusHistory` des DI passées par là.
 *
 * Le code TOLÈRE l'ancienne valeur `PROCESSING` en AFFICHAGE (timeline/maps
 * dual-clés côté front), donc cette migration peut tourner AVANT ou APRÈS le
 * déploiement sans casser les vues. 0 DI vive attendue en PROCESSING (seules
 * quelques entrées `statusHistory`).
 *
 * NB : ne touche PAS au `PROCESSING` du module `jira-cron-notification` (machine
 * d'état distincte : PENDING → PROCESSING → PROCESSED → FAILED) — ce script ne
 * cible que `dis`/`stats`/`logsdis`.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul, AUCUNE écriture. Idempotent.
 * Run (rapport) :
 *   mongosh "mongodb://localhost:27017/<DB>" migrations/009-rename-processing-to-confirmation.js
 * NB : chaque poste a SA base (localhost en dur) — lancer sur chacune.
 */
const DRY_RUN = true;

print('== Migration 009: PROCESSING → CONFIRMATION ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

const OLD = 'PROCESSING';
const NEW = 'CONFIRMATION';

// ── 1. status (dis + stats + logsdis) ──────────────────────────────────────
for (const name of ['dis', 'stats', 'logsdis']) {
  const col = db.getCollection(name);
  if (!col) continue;
  const n = col.countDocuments({ status: OLD });
  print(`  ${name}.status ${OLD} → ${NEW} : ${n}`);
  if (!DRY_RUN && n > 0) {
    const res = col.updateMany({ status: OLD }, { $set: { status: NEW } });
    print(`     appliqué : ${res.modifiedCount}`);
  }
}

// ── 2. statusHistory (entrées des DI passées par l'étape) ──────────────────
const hist = db.dis.countDocuments({ 'statusHistory.status': OLD });
print(`  dis.statusHistory[] ${OLD} → ${NEW} : ${hist}`);
if (!DRY_RUN && hist > 0) {
  const res = db.dis.updateMany(
    { 'statusHistory.status': OLD },
    { $set: { 'statusHistory.$[e].status': NEW } },
    { arrayFilters: [{ 'e.status': OLD }] },
  );
  print(`     appliqué (documents) : ${res.modifiedCount}`);
}

// ── Rapport ────────────────────────────────────────────────────────────────
print('--- ÉTAT APRÈS (ou attendu en dry-run) ---');
print('  dis en PROCESSING (résiduel) : ' + db.dis.countDocuments({ status: OLD }));
print('  dis en CONFIRMATION : ' + db.dis.countDocuments({ status: NEW }));
print('  dis avec statusHistory PROCESSING (résiduel) : ' +
  db.dis.countDocuments({ 'statusHistory.status': OLD }));
print(DRY_RUN ? '-- FIN (dry run). --' : '-- FIN (appliqué). --');
