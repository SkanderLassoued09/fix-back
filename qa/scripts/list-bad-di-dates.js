/**
 * DIAGNOSTIC (LECTURE SEULE) — DI dont un champ de date n'est PAS de type Date.
 *
 * Le schéma déclare `createdAt` / `updatedAt` en Date (via `timestamps: true`),
 * mais des documents hérités ou édités à la main peuvent y porter une CHAÎNE.
 * Une seule suffisait à faire tomber TOUTE l'agrégation du leaderboard
 * technicien : `$subtract` sur une chaîne interrompt le pipeline entier
 * (« can't $subtract date from string », remonté en 500 au client).
 *
 * Le pipeline est désormais blindé (`$convert … onError: null`), donc il ne
 * plante plus — mais les DI listées ici sortent quand même du calcul du TAT
 * quand leur valeur est illisible. Ce script sert à SAVOIR lesquelles, avant de
 * décider quoi que ce soit : on ne répare pas ce qu'on n'a pas regardé.
 *
 * N'ÉCRIT RIEN. La réparation vit dans `migrations/013-di-date-types.js`.
 *
 *   node scripts/list-bad-di-dates.js
 *   MONGO_DB=fixtronixproddb node scripts/list-bad-di-dates.js
 */
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';

// Champs que le code traite comme des dates.
const DATE_FIELDS = [
  'createdAt',
  'updatedAt',
  'statusUpdatedAt',
  'retourDate',
  'dateReception',
];

/** Une chaîne est-elle récupérable en Date ? (même critère que la migration) */
function parseable(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  const d = new Date(v);
  return !isNaN(d.getTime());
}

(async () => {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(MONGO_DB);
  const dis = db.collection('dis');

  console.log(`\n== DI · champs de date au mauvais type — base ${MONGO_DB} ==`);
  console.log(`   total DI : ${await dis.countDocuments({})}\n`);

  let grandTotal = 0;
  let recoverable = 0;
  let lost = 0;

  for (const field of DATE_FIELDS) {
    // Deux exclusions indispensables, sinon le rapport est noyé de faux positifs :
    //  - `$exists: true` — `$not: {$type:'date'}` matche aussi les champs ABSENTS
    //    (`statusUpdatedAt` l'est sur la majorité des DI) ;
    //  - `$ne: null` — `null` est un état LÉGITIME, pas une corruption : une DI
    //    sans retour porte `retourDate: null`. Sans ce filtre, on remontait 146
    //    « corruptions » qui n'en étaient pas une seule.
    // Ce qu'on cherche vraiment : une CHAÎNE (ou tout autre type) là où le code
    // attend une Date.
    const bad = await dis
      .find(
        { [field]: { $exists: true, $ne: null, $not: { $type: 'date' } } },
        { projection: { _idnum: 1, status: 1, [field]: 1 } },
      )
      .toArray();

    if (bad.length === 0) {
      console.log(`  ✅ ${field.padEnd(16)} aucun`);
      continue;
    }

    grandTotal += bad.length;
    console.log(`  ❌ ${field.padEnd(16)} ${bad.length} document(s)`);
    for (const d of bad) {
      const v = d[field];
      const ok = parseable(v);
      ok ? recoverable++ : lost++;
      console.log(
        `       ${String(d._id).padEnd(12)} ${String(d._idnum ?? '-').padEnd(8)}` +
          ` ${String(d.status ?? '-').padEnd(20)} ${typeof v}` +
          ` ${JSON.stringify(v)}  ${ok ? '→ récupérable' : '→ ILLISIBLE'}`,
      );
    }
  }

  console.log(
    `\n  bilan : ${grandTotal} valeur(s) au mauvais type` +
      ` · ${recoverable} récupérable(s) · ${lost} illisible(s)`,
  );
  if (grandTotal > 0) {
    console.log(
      '  → réparer avec : mongosh "<url>/<db>" migrations/013-di-date-types.js (DRY_RUN par défaut)',
    );
  }
  console.log('');

  await client.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
