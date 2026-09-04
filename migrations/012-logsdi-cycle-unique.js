/**
 * Migration 012 — Un seul snapshot `logsdis` par (DI, cycle de retour).
 *
 *   1. RECENSE les doublons `(_idDi, idIgnore)`.
 *   2. FUSIONNE chaque groupe en UNE ligne : le gagnant est celui qui porte le
 *      plus de champs renseignés (départage : le plus ancien `createdAt`), puis
 *      on y recopie, champ par champ, ce que les perdants sont seuls à porter.
 *      JAMAIS une suppression sèche : les liens devis/BC/BL/facture et le prix
 *      peuvent se trouver sur une ligne DIFFÉRENTE de celle qui porte le verdict.
 *   3. Crée l'INDEX UNIQUE `{ _idDi: 1, idIgnore: 1 }`.
 *
 * POURQUOI. `logsDiService.create` était un insert sec, appelé à chaque
 * affectation de technicien : une réaffectation créait une 2e ligne pour le même
 * cycle. L'écriture du verdict (`findOneAndUpdate`) et sa lecture (`findOne`)
 * pouvaient alors viser des documents différents — le routeur concluait « pas
 * d'erreur Fixtronix » et la DI partait en facturation. La création est
 * désormais idempotente ; cette migration nettoie l'existant et pose la
 * contrainte. Elle corrige aussi un bug visible : la liste des retours est
 * indexée PAR POSITION côté front (logsDi[0] = Retour 1), donc un doublon
 * décalait tous les libellés.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul, AUCUNE écriture.
 * Idempotent. Run (rapport) :
 *   mongosh "mongodb://localhost:27017/<DB>" migrations/012-logsdi-cycle-unique.js
 * NB : chaque poste a SA base (localhost en dur) — lancer sur chacune.
 */
const DRY_RUN = true;

print('== Migration 012: un snapshot logsdis par (DI, cycle) ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

const PROTECTED = ['_id', '_idDi', 'idIgnore', 'createdAt', 'updatedAt', '__v'];
const isEmpty = (v) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0);

// ── 1. Recensement ──────────────────────────────────────────────────────────
const groups = db.logsdis
  .aggregate([
    { $group: { _id: { d: '$_idDi', i: '$idIgnore' }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ])
  .toArray();

print('  lignes totales   : ' + db.logsdis.countDocuments({}));
print('  groupes en double: ' + groups.length);

if (groups.length === 0) {
  print('  ✅ aucun doublon.');
} else {
  groups.forEach((g) =>
    print('     DI ' + g._id.d + ' cycle ' + g._id.i + ' ×' + g.n),
  );
}

// ── 2. Fusion ───────────────────────────────────────────────────────────────
let merged = 0;
let removed = 0;

groups.forEach((g) => {
  const docs = db.logsdis.find({ _id: { $in: g.ids } }).toArray();

  // Score = nombre de champs réellement renseignés ; départage par ancienneté.
  const score = (d) =>
    Object.keys(d).filter((k) => PROTECTED.indexOf(k) < 0 && !isEmpty(d[k]))
      .length;
  docs.sort((a, b) => {
    const s = score(b) - score(a);
    if (s !== 0) return s;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });

  const winner = docs[0];
  const losers = docs.slice(1);

  // Ce que le gagnant n'a pas et qu'un perdant porte : on le récupère.
  const patch = {};
  losers.forEach((l) => {
    Object.keys(l).forEach((k) => {
      if (PROTECTED.indexOf(k) >= 0) return;
      if (!isEmpty(winner[k]) || isEmpty(l[k])) return;
      if (isEmpty(patch[k])) patch[k] = l[k];
    });
  });

  const patchedKeys = Object.keys(patch);
  print(
    '  → DI ' + g._id.d + ' cycle ' + g._id.i +
      ' : garde ' + winner._id +
      ', supprime ' + losers.length +
      (patchedKeys.length ? ', récupère [' + patchedKeys.join(', ') + ']' : ''),
  );

  if (!DRY_RUN) {
    if (patchedKeys.length) {
      db.logsdis.updateOne({ _id: winner._id }, { $set: patch });
      merged++;
    }
    const del = db.logsdis.deleteMany({ _id: { $in: losers.map((l) => l._id) } });
    removed += del.deletedCount;
  }
});

// ── 3. Index unique ─────────────────────────────────────────────────────────
if (DRY_RUN) {
  print('-- FIN (dry run). Relancer avec DRY_RUN = false pour appliquer. --');
} else {
  const left = db.logsdis
    .aggregate([
      { $group: { _id: { d: '$_idDi', i: '$idIgnore' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  if (left.length > 0) {
    print('  ⛔ STOP : ' + left.length + ' groupe(s) encore en double, index NON posé.');
  } else {
    db.logsdis.createIndex({ _idDi: 1, idIgnore: 1 }, { unique: true });
    print('  ✅ index unique { _idDi, idIgnore } posé.');
  }
  print('  fusions: ' + merged + ' | lignes supprimées: ' + removed);
  print('-- FIN (apply). --');
}
