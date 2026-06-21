/**
 * Migration 001 — backfill `isDeleted: false` on legacy documents.
 *
 * Why: the codebase added soft-delete and several list queries filter with an
 * EXACT match `{ isDeleted: false }` (clients, locations, profiles, composants,
 * …). MongoDB treats a MISSING field as != false, so any legacy prod document
 * created before soft-delete existed would be SILENTLY EXCLUDED from those
 * lists (e.g. 59/62 companies were missing the field). This sets the field to
 * `false` only where it is absent — fully idempotent, non-destructive.
 *
 * Run:  mongosh "mongodb://localhost:27017/fixtronixproddb" migrations/001-backfill-isdeleted.js
 * Re-running is a no-op (the $exists:false filter matches nothing the 2nd time).
 */
const COLLECTIONS = [
  'dis',
  'clients',
  'companies',
  'composants',
  'composant_categories',
  'dicategories',
  'locations',
  'profiles',
  'tarifs',
  'logsdis',
  'stats',
  'audits',
  'remarques',
];

print('== Migration 001: backfill isDeleted ==');
let total = 0;
for (const name of COLLECTIONS) {
  const col = db.getCollection(name);
  if (!col) continue;
  const missing = col.countDocuments({ isDeleted: { $exists: false } });
  if (missing === 0) {
    print('  ' + name + ': ok (nothing to backfill)');
    continue;
  }
  const res = col.updateMany(
    { isDeleted: { $exists: false } },
    { $set: { isDeleted: false } },
  );
  total += res.modifiedCount;
  print('  ' + name + ': backfilled ' + res.modifiedCount + ' / ' + missing);
}
print('== Done. Total documents updated: ' + total + ' ==');
