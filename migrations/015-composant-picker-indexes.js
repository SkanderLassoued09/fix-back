/**
 * Migration 015 — Index du picker de composants (arbre du modal diagnostic).
 *
 * POURQUOI. `composant.entity.ts` déclare
 *   ComposantSchema.index({ category_composant_id: 1, isDeleted: 1 })
 * mais le schéma porte `@Schema({ autoIndex: false })` : Mongoose ne crée donc
 * JAMAIS cet index. La collection n'a, en pratique, que `_id` (+ les uniques
 * hérités). Même situation — et même remède — que `stats` en migration 014 :
 * l'index est posé explicitement par un script.
 *
 * Le nouveau picker interroge `composants` par catégorie, trié par nom :
 *   find({ category_composant_id, isDeleted: {$ne:true} }).sort({name:1})
 * d'où un index composé qui couvre le filtre ET le tri.
 *
 * CE QUE ÇA NE RÈGLE PAS (à dire franchement) : la recherche profonde utilise
 * une regex NON ANCRÉE avec $options:'i'. Aucun index B-tree ne peut la servir
 * — c'est un balayage, par construction. À l'échelle actuelle du catalogue
 * (~186 documents) c'est sans conséquence, et le `.limit()` borne le coût.
 * L'index ci-dessous sert la NAVIGATION par catégorie et le TRI.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut → rapport seul, AUCUNE écriture.
 * Idempotent (`createIndex` sur un index identique est un no-op). Run :
 *   mongosh "mongodb://localhost:27017/<DB>" migrations/015-composant-picker-indexes.js
 * NB : chaque poste a SA base (localhost en dur) — lancer sur chacune.
 */
const DRY_RUN = true;

print('== Migration 015: index du picker de composants ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

const WANTED = [
  {
    key: { category_composant_id: 1, isDeleted: 1, name: 1 },
    name: 'composant_category_isDeleted_name',
    why: 'navigation par catégorie + tri alphabétique du picker',
  },
];

// ── 1. Recensement ──────────────────────────────────────────────────────────
const total = db.composants.countDocuments({});
print('  composants          : ' + total);

const existing = db.composants.getIndexes();
print('  index déjà en place : ' + existing.map((i) => i.name).join(', '));

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Répartition par catégorie — sert à vérifier que le repli « Sans catégorie »
// du service a bien quelque chose à rattraper (pollution héritée par libellé).
const knownIds = db.composant_categories
  .find({ isDeleted: { $ne: true } }, { _id: 1, category_composant: 1 })
  .toArray();
const known = {};
knownIds.forEach((c) => {
  known[String(c._id)] = true;
  known[String(c.category_composant || '').trim().toLowerCase()] = true;
});

let orphans = 0;
db.composants
  .aggregate([
    { $match: { isDeleted: { $ne: true } } },
    { $group: { _id: '$category_composant_id', n: { $sum: 1 } } },
  ])
  .toArray()
  .forEach((g) => {
    const raw = String(g._id === null || g._id === undefined ? '' : g._id).trim();
    const blank = raw === '' || raw === 'undefined' || raw === 'null';
    if (blank || !(known[raw] || known[raw.toLowerCase()])) {
      orphans += g.n;
      print(
        '     ↯ ' + g.n + ' composant(s) sur une catégorie inconnue : ' +
          (blank ? '(vide)' : '« ' + raw + ' »'),
      );
    }
  });
print(
  '  → ' + orphans +
    ' composant(s) tomberont dans le nœud « Sans catégorie » du picker.',
);

// ── 2. Pose des index ───────────────────────────────────────────────────────
WANTED.forEach((idx) => {
  const already = existing.some((e) => sameKey(e.key, idx.key));
  if (already) {
    print('  ✅ déjà posé : ' + idx.name + ' (' + idx.why + ')');
    return;
  }
  print('  → à créer : ' + idx.name + ' = ' + JSON.stringify(idx.key));
  print('              ' + idx.why);
  if (!DRY_RUN) {
    db.composants.createIndex(idx.key, { name: idx.name, background: true });
    print('  ✅ créé : ' + idx.name);
  }
});

print(
  DRY_RUN
    ? '-- FIN (dry run). Relancer avec DRY_RUN = false pour appliquer. --'
    : '-- FIN (apply). --',
);
