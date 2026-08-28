#!/usr/bin/env node
/**
 * Seed d'un DI par COMBO RETOUR pour test MANUEL dans l'app.
 * Chaque DI est un RETOUR (ignoreCount=1) en INDIAGNOSTIC, affecté au tech, avec
 * un snapshot de cycle `logsdis` portant le verdict (Fixtronix / PDR / réparable).
 * Ouvre la liste tech, termine le diagnostic de chaque DI, observe le routage.
 *
 *   node qa/scripts/seed-retour-combos.mjs            # seed
 *   node qa/scripts/seed-retour-combos.mjs --clean    # supprime les DI_combo_*
 *   MONGO_DB=fixtronixproddb node qa/scripts/seed-retour-combos.mjs
 *
 * Le driver mongodb est résolu depuis qa/node_modules (devDependency du package qa).
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const TECH_ID = '6623d4fea953a0ebca67e7db'; // profile `tech` sur fixtronixproddb
const CLIENT_ID = 'C1';
const PREFIX = 'DI_combo_';

// Les 8 combos retour. `expected` = routage attendu à la fin du diagnostic.
const COMBOS = [
  { key: 'fix-pdr-rep', fix: true, pdr: true, rep: true, expected: 'Magasin → PENDING3' },
  { key: 'fix-pdr-nrep', fix: true, pdr: true, rep: false, expected: 'IRREPARABLE (direct, magasin sauté)' },
  { key: 'fix-nopdr-rep', fix: true, pdr: false, rep: true, expected: 'PENDING3 (direct, non facturé)' },
  { key: 'fix-nopdr-nrep', fix: true, pdr: false, rep: false, expected: 'IRREPARABLE (direct)' },
  { key: 'cli-pdr-rep', fix: false, pdr: true, rep: true, expected: 'Magasin → … → Pricing (facturer ?) → PENDING3' },
  { key: 'cli-pdr-nrep', fix: false, pdr: true, rep: false, expected: 'IRREPARABLE (direct, magasin sauté)' },
  { key: 'cli-nopdr-rep', fix: false, pdr: false, rep: true, expected: 'PENDING2 → Pricing (facturer ?)' },
  { key: 'cli-nopdr-nrep', fix: false, pdr: false, rep: false, expected: 'IRREPARABLE (direct) + docs (2C)' },
];

const label = (c) =>
  `COMBO ${c.fix ? 'Fixtronix' : 'Client'} + ${c.pdr ? 'PDR' : 'sansPDR'} + ${c.rep ? 'réparable' : 'NON-réparable'}`;

async function main() {
  const clean = process.argv.includes('--clean');
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(MONGO_DB);
  const dis = db.collection('dis');
  const stats = db.collection('stats');
  const logsdis = db.collection('logsdis');

  const ids = COMBOS.map((c) => PREFIX + c.key);

  // Toujours nettoyer d'abord (idempotent), puis re-seed sauf si --clean.
  const delDis = await dis.deleteMany({ _id: { $in: ids } });
  await stats.deleteMany({ _idDi: { $in: ids } });
  await logsdis.deleteMany({ _idDi: { $in: ids } });

  if (clean) {
    console.log(`Nettoyage : ${delDis.deletedCount} DI_combo_* supprimées.`);
    await client.close();
    return;
  }

  const now = new Date();
  let n = 0;
  for (const c of COMBOS) {
    n += 1;
    const _id = PREFIX + c.key;
    const idnum = `COMBO-${String(n).padStart(2, '0')}`;
    // Non réparable ⇒ pas de PDR (règle métier) : on force la liste vide.
    const comps = c.pdr && c.rep ? [{ nameComposant: 'Fusible', quantity: 1 }] : [];
    await dis.insertOne({
      _id,
      _idnum: idnum,
      title: label(c),
      description: `Attendu : ${c.expected}`,
      status: 'INDIAGNOSTIC',
      ignoreCount: 1,
      can_be_repaired: c.rep,
      contain_pdr: c.pdr && c.rep,
      array_composants: comps,
      isErrorFromFixtronix: c.fix,
      client_id: CLIENT_ID,
      current_workers_ids: [TECH_ID],
      current_roles: ['Tech'],
      isDeleted: false,
      statusUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await stats.insertOne({
      _id: `stat-${_id}`,
      _idDi: _id,
      diRef: _id,
      id_tech_diag: TECH_ID,
      id_tech_rep: TECH_ID,
      status: 'INDIAGNOSTIC',
      diag_time: '00:00:00',
      ignoreCount: 1,
      retour_count: 1,
      pauseLogs: [],
      createdAt: now,
      updatedAt: now,
    });
    await logsdis.insertOne({
      _id: `log-${_id}`,
      _idDi: _id,
      idIgnore: 1,
      can_be_repaired: c.rep,
      contain_pdr: c.pdr && c.rep,
      array_composants: comps,
      isErrorFromFixtronix: c.fix,
      createdAt: now,
      updatedAt: now,
    });
  }

  console.log(`\nSeed OK — ${COMBOS.length} DI de test (DB ${MONGO_DB}) :\n`);
  COMBOS.forEach((c, i) =>
    console.log(
      `  COMBO-${String(i + 1).padStart(2, '0')}  ${label(c).padEnd(48)} → ${c.expected}`,
    ),
  );
  console.log(
    `\nAffectées au tech ${TECH_ID}. Ouvre la liste technicien, termine chaque diagnostic, observe le routage.`,
  );
  console.log(`Nettoyage : node qa/scripts/seed-retour-combos.mjs --clean\n`);
  await client.close();
}

main().catch((e) => {
  console.error('ERREUR seed :', e?.message ?? e);
  process.exit(1);
});
