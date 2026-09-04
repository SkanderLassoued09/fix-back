/**
 * Migration 011 — Backfill HONNÊTE de `statusHistory`.
 *
 * CONSTAT : sur la base de dev, 264 DI sur 387 ont un `statusHistory` VIDE. Le
 * hook Mongoose ne poussait l'historique que sur la forme `$set` ; la forme
 * directe stampait `statusUpdatedAt` sans rien journaliser (colmaté dans
 * `di.entity.ts`). Conséquence UI : la timeline « Écart entre statuts » et
 * l'onglet Journal du dossier sont VIDES pour ces DI.
 *
 * CE QUE FAIT CETTE MIGRATION — uniquement ce qui est RÉELLEMENT connu :
 *   • `{ status: 'CREATED',        at: createdAt }`
 *   • `{ status: <statut courant>, at: statusUpdatedAt || updatedAt || createdAt }`
 * Les deux entrées portent `reconstructed: true` et l'UI les affiche comme
 * telles.
 *
 * CE QU'ELLE N'INVENTE PAS : aucune étape intermédiaire, aucune date de RETOUR.
 * Une DI retournée n'aura donc toujours pas de découpage par cycle — c'est
 * honnête : ces dates sont perdues, on ne les fabrique pas.
 *
 * IDEMPOTENTE : ne touche QUE les DI dont `statusHistory` est absent ou vide.
 * Relancer ne réécrit rien.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul, AUCUNE écriture.
 * Run (rapport) :
 *   mongosh "mongodb://localhost:27017/fixtronixproddb" migrations/011-backfill-status-history.js
 * NB : la base applicative est `fixtronixproddb` (cf. MONGODB_URI) — `fixtronix`
 * est une base morte. Chaque poste a la sienne : lancer sur chacune.
 */
const DRY_RUN = true;

print('== Migration 011: backfill honnête de statusHistory ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

const EMPTY = {
  $or: [
    { statusHistory: { $exists: false } },
    { statusHistory: null },
    { statusHistory: { $size: 0 } },
  ],
};

const total = db.dis.countDocuments({});
const target = db.dis.countDocuments(EMPTY);
print('  DI totales : ' + total + ' | sans historique : ' + target);

if (target === 0) {
  print('  Rien à faire — toutes les DI ont déjà un historique.');
  print('-- FIN. --');
} else {
  let planned = 0;
  let skipped = 0;
  const sample = [];

  db.dis.find(EMPTY, { _idnum: 1, status: 1, createdAt: 1, updatedAt: 1, statusUpdatedAt: 1 }).forEach((d) => {
    const created = d.createdAt || d.updatedAt || d.statusUpdatedAt;
    // Sans la moindre date ni statut, on ne peut RIEN affirmer : on passe.
    if (!created || !d.status) {
      skipped++;
      return;
    }
    const currentAt = d.statusUpdatedAt || d.updatedAt || created;

    const entries = [{ status: 'CREATED', at: created, reconstructed: true }];
    // Si le statut courant est CREATED, la première entrée suffit — pas de
    // doublon. Idem si la date courante précède la création (données douteuses).
    if (d.status !== 'CREATED' && currentAt >= created) {
      entries.push({ status: d.status, at: currentAt, reconstructed: true });
    }

    if (sample.length < 5) {
      sample.push(
        '     ' + (d._idnum || d._id) + ' → ' + entries.map((e) => e.status).join(' · '),
      );
    }
    planned++;
    if (!DRY_RUN) {
      db.dis.updateOne({ _id: d._id }, { $set: { statusHistory: entries } });
    }
  });

  print('  DI à reconstruire : ' + planned + ' | ignorées (ni date ni statut) : ' + skipped);
  if (sample.length) {
    print('  Échantillon :');
    sample.forEach((l) => print(l));
  }
  print(
    DRY_RUN
      ? '-- FIN (dry run). Repasser DRY_RUN=false pour appliquer. --'
      : '-- FIN (appliqué). --',
  );
}
