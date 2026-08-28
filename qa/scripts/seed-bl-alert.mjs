#!/usr/bin/env node
/**
 * Seed d'une DI pour VOIR l'alerte BL « cœur qui bat » dans l'app.
 * Insère une DI en INREPARATION puis la fait ENTRER en WAITING_BL via la vraie
 * mutation `changestatusToFinishReparation` — c'est CE passage qui émet la notif
 * PERSISTANTE `DI_DOC_BL_PENDING` (cœur qui bat + son en boucle côté front),
 * poussée aux rôles de coordination. Ouvre l'app connecté en Coordinateur /
 * Manager / Admin pour voir la cloche battre + entendre le son (jusqu'à l'upload
 * du BL ou le snooze).
 *
 *   node qa/scripts/seed-bl-alert.mjs           # seed + déclenche l'alerte
 *   node qa/scripts/seed-bl-alert.mjs --clean   # supprime la DI de test
 *   MONGO_DB=fixtronixproddb node qa/scripts/seed-bl-alert.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const GRAPHQL = process.env.GRAPHQL_URL ?? 'http://localhost:3000/graphql';
const ID = 'DI_blalert_demo';
const IDNUM = 'BL-ALERT-DEMO';

async function gql(query) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-run': '1' },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

async function main() {
  const clean = process.argv.includes('--clean');
  const c = new MongoClient(MONGO_URL);
  await c.connect();
  const db = c.db(MONGO_DB);

  await db.collection('dis').deleteOne({ _id: ID });
  await db.collection('stats').deleteMany({ _idDi: ID });
  await db.collection('notifications').deleteMany({ diId: ID });
  await db.collection('system_events').deleteMany({ diId: ID });

  if (clean) {
    console.log('Nettoyage : DI_blalert_demo + notifications supprimées.');
    await c.close();
    return;
  }

  const now = new Date();
  await db.collection('dis').insertOne({
    _id: ID,
    _idnum: IDNUM,
    title: 'DEMO alerte BL (cœur qui bat)',
    status: 'INREPARATION',
    ignoreCount: 0,
    can_be_repaired: true,
    contain_pdr: false,
    client_id: 'C1',
    current_roles: ['Tech'],
    array_composants: [],
    isDeleted: false,
    statusUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('stats').insertOne({
    _id: `stat-${ID}`,
    _idDi: ID,
    status: 'INREPARATION',
    ignoreCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  // Fin de réparation → WAITING_BL → émet DI_DOC_BL_PENDING (alerte battante).
  const r = await gql(
    `mutation { changestatusToFinishReparation(_id: "${ID}") { _id status } }`,
  );
  if (r?.errors?.length) {
    console.error('Mutation en erreur :', JSON.stringify(r.errors));
    await c.close();
    process.exit(1);
  }

  const di = await db
    .collection('dis')
    .findOne({ _id: ID }, { projection: { status: 1 } });
  const blNotifs = await db
    .collection('notifications')
    .find({ diId: ID, type: 'DI_DOC_BL_PENDING' })
    .toArray();
  const recipients = [...new Set(blNotifs.map((n) => String(n.userId)))];

  console.log(`\nDI ${IDNUM} → statut = ${di?.status} (attendu WAITING_BL)`);
  console.log(
    `Notif DI_DOC_BL_PENDING créée pour ${recipients.length} destinataire(s) de coordination.`,
  );
  console.log(
    `\n👉 Connecte-toi en Coordinateur / Manager / Admin, ouvre l'app :`,
  );
  console.log(
    `   - la CLOCHE bat (rouge) + son « lub-dub » en boucle ;`,
  );
  console.log(
    `   - la notif « Bon de livraison à téléverser (${IDNUM}) » reste tant que le BL n'est pas uploadé ;`,
  );
  console.log(`   - bouton ⏸ = snooze (coupe le son, l'alerte continue de battre) ;`);
  console.log(
    `   - téléverse le BL (DI ${IDNUM}, bouton Fichiers) → l'alerte DISPARAÎT en temps réel (son coupé).`,
  );
  console.log(`\nNettoyage : node qa/scripts/seed-bl-alert.mjs --clean\n`);
  await c.close();
}

main().catch((e) => {
  console.error('ERREUR :', e?.message ?? e);
  process.exit(1);
});
