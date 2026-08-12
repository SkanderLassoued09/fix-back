/**
 * Migration 007 — Renommage du statut magasin : MAGASIN_PREPARATION → PROCESSING.
 *
 * La valeur de statut « préparation magasin » (clé TS `InMagasin`) passe de
 * `MAGASIN_PREPARATION` à `PROCESSING`. AUCUN alias legacy n'est conservé côté
 * code, donc cette migration doit être APPLIQUÉE pour que les DI existantes
 * restent cohérentes.
 *
 * Renomme :
 *   1. `di.status` (`dis`, `stats`, `logsdis`) : MAGASIN_PREPARATION → PROCESSING ;
 *   2. les entrées `statusHistory[].status` des DI passées par ce statut.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul (comptes avant/après),
 * AUCUNE écriture. Idempotent. Run (rapport) :
 *   mongosh "mongodb://localhost:27017/<DB>" migrations/007-rename-magasin-preparation-to-processing.js
 */
const DRY_RUN = true;

print('== Migration 007: MAGASIN_PREPARATION → PROCESSING ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

const OLD = 'MAGASIN_PREPARATION';
const NEW = 'PROCESSING';

// ── 1. Champ di.status (dis + stats + logsdis) ──────────────────────────────
for (const name of ['dis', 'stats', 'logsdis']) {
  const col = db.getCollection(name);
  const n = col.countDocuments({ status: OLD });
  print(`  ${name}.status : ${OLD} → ${NEW} : ${n}`);
  if (!DRY_RUN && n > 0)
    col.updateMany({ status: OLD }, { $set: { status: NEW } });
}

// ── 2. Entrées statusHistory (dis) ──────────────────────────────────────────
const dis = db.getCollection('dis');
const hist = dis.countDocuments({ 'statusHistory.status': OLD });
print(`  dis.statusHistory[] : ${OLD} → ${NEW} : ${hist} DI concernée(s)`);
if (!DRY_RUN && hist > 0)
  dis.updateMany(
    { 'statusHistory.status': OLD },
    { $set: { 'statusHistory.$[e].status': NEW } },
    { arrayFilters: [{ 'e.status': OLD }] },
  );

// ── 3. Contrôle : aucune valeur inconnue résiduelle ─────────────────────────
if (!DRY_RUN) {
  print(`  RESTANT dis.status=${OLD} : ${dis.countDocuments({ status: OLD })}`);
  print(
    `  RESTANT dis.statusHistory=${OLD} : ${dis.countDocuments({ 'statusHistory.status': OLD })}`,
  );
}

print(DRY_RUN ? '-- FIN (dry run). --' : '-- FIN (appliqué). --');
