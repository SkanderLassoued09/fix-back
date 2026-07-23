/**
 * Migration 002 — réparer la pollution « libellé » de `category_composant_id`.
 *
 * Why: avant le fix front (2026-07-22), les dropdowns Catégorie envoyaient le
 * LIBELLÉ de la catégorie (« CAT COMP A ») au lieu de son `_id`
 * (« C_Composant1 »), et le back l'écrivait tel quel. Le back rejette
 * désormais ces valeurs (BAD_USER_INPUT) et le front traduit à la volée
 * (`normalizeCategoryId`), mais les documents jamais rouverts gardent un
 * libellé en base. Ce script traduit libellé → `_id` correspondant
 * (insensible à la casse, trim) et RAPPORTE les non-résolvables sans y
 * toucher.
 *
 * SÉCURITÉ : DRY_RUN = true par défaut — le script ne fait que RAPPORTER.
 * Passer DRY_RUN à false (ci-dessous) pour appliquer réellement.
 *
 * Run (rapport seul) :
 *   mongosh "mongodb://localhost:27017/fixtronix" migrations/002-fix-category-label-pollution.js
 * Ré-exécution : no-op une fois les valeurs traduites (idempotent).
 * NB : chaque poste a SA base (localhost en dur) — à lancer sur chacune.
 */
const DRY_RUN = true;

print('== Migration 002: category_composant_id label -> _id ==');
print(DRY_RUN ? '-- DRY RUN (aucune écriture) --' : '-- APPLY --');

// Libellé (normalisé) -> _id. Les catégories non supprimées priment ; un
// libellé ambigu (2 catégories distinctes) est marqué non-résolvable.
const norm = (s) => String(s).trim().toLowerCase();
const labelMap = new Map();
const ambiguous = new Set();
const register = (cat) => {
  const key = norm(cat.category_composant);
  const existing = labelMap.get(key);
  if (existing && existing !== cat._id) {
    ambiguous.add(key);
    return;
  }
  labelMap.set(key, cat._id);
};
db.composant_categories
  .find({ isDeleted: { $ne: true } })
  .forEach(register);
// Fallback : catégories supprimées, uniquement pour les libellés inconnus.
db.composant_categories
  .find({ isDeleted: true })
  .forEach((cat) => {
    if (!labelMap.has(norm(cat.category_composant))) register(cat);
  });

const validIds = new Set(db.composant_categories.distinct('_id'));

let resolved = 0;
const unresolvable = [];
db.composants
  .find(
    { category_composant_id: { $exists: true, $nin: [null, ''] } },
    { name: 1, category_composant_id: 1 },
  )
  .forEach((doc) => {
    const value = doc.category_composant_id;
    if (validIds.has(value)) return; // déjà un _id valide
    const key = norm(value);
    const targetId = ambiguous.has(key) ? null : labelMap.get(key);
    if (!targetId) {
      unresolvable.push(doc);
      return;
    }
    resolved += 1;
    print(
      `  ${doc._id} (${doc.name}) : '${value}' -> '${targetId}'` +
        (DRY_RUN ? ' [dry-run]' : ''),
    );
    if (!DRY_RUN) {
      db.composants.updateOne(
        { _id: doc._id, category_composant_id: value },
        { $set: { category_composant_id: targetId } },
      );
    }
  });

print(`Résolus : ${resolved}${DRY_RUN ? ' (non appliqués — dry-run)' : ''}`);
print(`Non-résolvables (laissés intacts) : ${unresolvable.length}`);
unresolvable.forEach((doc) =>
  print(
    `  !! ${doc._id} (${doc.name}) : '${doc.category_composant_id}' ` +
      `ne correspond à aucune catégorie — à corriger à la main`,
  ),
);
