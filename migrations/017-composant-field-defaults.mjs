/**
 * Migration 017 — initialiser les champs vides des composants existants.
 *
 * POURQUOI. Décision du 2026-09-15 : aucun champ d'un Composant ne reste `null`,
 * absent, ni porteur d'une sentinelle (« undefined », « null », « NaN »,
 * « Invalid Date ») écrite par une interpolation front non gardée. Les
 * composants CRÉÉS désormais sont initialisés par `createComposant`
 * (`src/composant/composant-defaults.ts`) ; celle-ci remet l'existant au même
 * niveau.
 *
 * CE QUE ÇA FAIT, pour CHAQUE composant (supprimés compris) :
 *   - texte  (package, category_composant_id, coming_date, link, pdf,
 *     status_composant, code_article, emplacement) absent / null / sentinelle
 *     → '' ; une valeur non textuelle réelle est convertie en texte ;
 *   - nombre (prix_achat, prix_vente, quantity_stocked, stock_min) absent /
 *     null / non numérique → 0 ; une chaîne numérique est convertie. Un prix à 0
 *     signifie « pas de prix » (le rappel magasin le compte comme manquant) ;
 *   - isDeleted absent → false.
 * JAMAIS touchés : _id, name, merged_into, toute valeur réelle (dates héritées
 * au format `Date.toString()` comprises). `updatedAt` n'est pas modifié : c'est
 * de l'hygiène de données, pas une modification métier.
 *
 * SÉCURITÉ : DRY-RUN par défaut (rapport seul). `--apply` pour écrire.
 * Idempotent : un 2ᵉ passage ne trouve plus rien à initialiser.
 *
 * Run (depuis fix-back/) :
 *   node migrations/017-composant-field-defaults.mjs
 *   node migrations/017-composant-field-defaults.mjs --apply
 * Env : MONGO_URL (défaut mongodb://127.0.0.1:27017), MONGO_DB (défaut
 * fixtronixproddb). NB : chaque poste a SA base — lancer sur chacune.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { MongoClient } = require('mongodb');

const APPLY = process.argv.slice(2).includes('--apply');
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';

// La base `fixtronix` existe encore sur le même mongod mais est MORTE.
if (MONGO_DB === 'fixtronix') {
  console.error("Refus : la base « fixtronix » est morte — la base applicative est « fixtronixproddb ».");
  process.exit(1);
}

// Miroir de src/composant/composant-defaults.ts (ce script tourne sous node nu).
const TEXT_FIELDS = [
  'package', 'category_composant_id', 'coming_date', 'link', 'pdf',
  'status_composant', 'code_article', 'emplacement',
];
const NUMBER_FIELDS = ['prix_achat', 'prix_vente', 'quantity_stocked', 'stock_min'];
const SENTINELS = new Set(['undefined', 'null', 'NaN', 'Invalid Date']);

function textOrDefault(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  return SENTINELS.has(s.trim()) ? '' : s;
}

function numberOrDefault(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** `$set` minimal d'un composant : uniquement les champs à initialiser. */
function patchFor(doc) {
  const set = {};
  for (const f of TEXT_FIELDS) {
    const next = textOrDefault(doc[f]);
    if (doc[f] !== next) set[f] = next;
  }
  for (const f of NUMBER_FIELDS) {
    const next = numberOrDefault(doc[f]);
    if (doc[f] !== next) set[f] = next;
  }
  if (typeof doc.isDeleted !== 'boolean') set.isDeleted = false;
  return set;
}

async function scan(col) {
  const projection = Object.fromEntries(
    ['_id', 'name', 'isDeleted', ...TEXT_FIELDS, ...NUMBER_FIELDS].map((f) => [f, 1]),
  );
  const docs = await col.find({}, { projection }).toArray();
  const updates = [];
  const perField = {};
  for (const doc of docs) {
    const set = patchFor(doc);
    const keys = Object.keys(set);
    if (!keys.length) continue;
    updates.push({ _id: doc._id, name: doc.name, set, before: Object.fromEntries(keys.map((k) => [k, doc[k]])) });
    for (const k of keys) perField[k] = (perField[k] ?? 0) + 1;
  }
  return { total: docs.length, updates, perField };
}

const client = new MongoClient(MONGO_URL);
await client.connect();
try {
  const col = client.db(MONGO_DB).collection('composants');
  const { total, updates, perField } = await scan(col);

  console.log(`\nBase ${MONGO_DB} — ${total} composants, ${updates.length} à initialiser.`);
  for (const [field, n] of Object.entries(perField).sort()) {
    console.log(`  ${field.padEnd(22)} ${String(n).padStart(4)}`);
  }
  for (const u of updates.slice(0, 5)) {
    console.log(`  ex. ${u._id} « ${u.name} » : ${JSON.stringify(u.before)} → ${JSON.stringify(u.set)}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN : rien écrit. Relancer avec --apply pour appliquer.');
  } else if (updates.length) {
    const res = await col.bulkWrite(
      updates.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: u.set } } })),
      { ordered: true },
    );
    const after = await scan(col);
    console.log(`\nAPPLIQUÉ : ${res.modifiedCount} composants modifiés.`);
    console.log(`Contrôle : ${after.updates.length} composant(s) restant(s) à initialiser (attendu 0).`);
  } else {
    console.log('\nRien à appliquer : tous les champs sont déjà initialisés.');
  }
} finally {
  await client.close();
}
