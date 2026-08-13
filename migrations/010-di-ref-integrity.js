/**
 * Migration 010 — Intégrité de la référence DI (`_idnum`).
 *
 *   1. GARDE : refuse de continuer s'il existe des doublons de `_idnum`
 *      (l'index unique ne pourrait pas être posé). Les liste le cas échéant.
 *   2. Seed du compteur atomique `counters/di_ref` au MAX existant (idempotent,
 *      `$max` ne fait jamais redescendre). Le prochain `T{n}` = seq+1.
 *   3. Crée l'INDEX UNIQUE `{ _idnum: 1 }` sur `dis`.
 *
 * Le code back seede aussi le compteur paresseusement au boot (garde-fou) et
 * déclare l'index dans le schéma ; cette migration le rend EXPLICITE sur les
 * bases existantes, sans dépendre de l'autoIndex.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport + garde seule, AUCUNE écriture
 * ni création d'index. Idempotent. Run (rapport) :
 *   mongosh "mongodb://localhost:27017/<DB>" migrations/010-di-ref-integrity.js
 * NB : chaque poste a SA base (localhost en dur) — lancer sur chacune.
 */
const DRY_RUN = true;

print('== Migration 010: intégrité référence DI (_idnum) ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

// ── 1. GARDE : doublons _idnum ──────────────────────────────────────────────
const dupes = db.dis
  .aggregate([
    { $match: { _idnum: { $nin: [null, ''] } } },
    { $group: { _id: '$_idnum', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ])
  .toArray();
const missing = db.dis.countDocuments({
  $or: [{ _idnum: null }, { _idnum: '' }, { _idnum: { $exists: false } }],
});
print('  _idnum en doublon : ' + dupes.length + ' | _idnum manquant : ' + missing);
if (dupes.length > 0 || missing > 0) {
  print('  ⛔ STOP : résoudre les doublons/vides AVANT de poser l’index unique.');
  dupes.forEach((d) => print('     doublon « ' + d._id + ' » ×' + d.n));
  print('-- FIN (garde). --');
} else {
  // ── 2. Seed compteur ──────────────────────────────────────────────────────
  let max = 0;
  db.dis.find({ _idnum: { $nin: [null, ''] } }, { _idnum: 1 }).forEach((d) => {
    const m = String(d._idnum).match(/^(?:DI|T)(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  });
  print('  counters/di_ref → seq = ' + max + '  (prochain T{n} = ' + (max + 1) + ')');
  if (!DRY_RUN) {
    db.counters.updateOne(
      { _id: 'di_ref' },
      { $max: { seq: max } },
      { upsert: true },
    );
  }

  // ── 3. Index unique ────────────────────────────────────────────────────────
  // IDEMPOTENT : on détecte tout index existant sur `_idnum` (quel que soit son
  // nom) et on NE recrée pas. On utilise le NOM PAR DÉFAUT (`_idnum_1`) — le même
  // que Mongoose `autoIndex` — pour qu'un 2ᵉ passage / le boot de l'app ne
  // provoquent aucun conflit de nom. On ne DROP jamais un index existant.
  const existingIdnumIdx = db.dis
    .getIndexes()
    .find((ix) => ix.key && ix.key._idnum === 1 && Object.keys(ix.key).length === 1);
  if (existingIdnumIdx) {
    if (existingIdnumIdx.unique) {
      print(
        '  index unique { _idnum: 1 } déjà présent (' +
          existingIdnumIdx.name +
          ') — rien à faire.',
      );
    } else {
      print(
        '  ⚠ index { _idnum: 1 } présent mais NON unique (' +
          existingIdnumIdx.name +
          '). À traiter manuellement (drop puis recréation unique) — la migration ne DROP rien.',
      );
    }
  } else {
    print('  index unique { _idnum: 1 } sur dis : ' + (DRY_RUN ? 'à créer' : 'création…'));
    if (!DRY_RUN) {
      db.dis.createIndex({ _idnum: 1 }, { unique: true }); // nom par défaut `_idnum_1`
      print('     créé (_idnum_1).');
    }
  }
  print(DRY_RUN ? '-- FIN (dry run). --' : '-- FIN (appliqué). --');
}
