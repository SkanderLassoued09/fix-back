/**
 * Crée une DI qui a VRAIMENT traversé tout le flux d'origine, puis l'ouvre en
 * RETOUR 1 — pour disposer d'une DI retour avec l'historique complet du cycle
 * 0 (dates de statut, Stat diag/répa, ligne logsdis, documents Drive).
 *
 * Chaque saut passe par la VRAIE mutation GraphQL, avec le jeton du rôle qui la
 * déclenche dans l'app (storageState `qa/.auth`). Diagnostic ET réparation du
 * flux d'origine affectés au technicien « tech ». AUCUN forçage de statut en
 * base : au premier écart, le script s'arrête et dit où.
 *
 * ⚠️ Téléverse 4 PDF de test (devis, BC, BL, facture) sur Drive, dans le
 * dossier du client de test « SKANDER LASSOUED », et décrémente le stock du
 * composant utilisé (1 × 10µF25V).
 *
 * Prérequis : back (:3000) et mongo (:27017) démarrés.
 *   node qa/scripts/seed-retour-history.mjs
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { MongoClient } = require('mongodb');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const GRAPHQL_URL = (process.env.API_URL ?? 'http://localhost:3000') + '/graphql';

const CLIENT_ID = 'C4'; // SKANDER LASSOUED — client de test
const COMPOSANT = { name: '10µF25V', quantity: 1 };

function tok(role) {
  const st = JSON.parse(fs.readFileSync(path.join(DIR, '..', '.auth', role + '.json'), 'utf8'));
  return (st.origins?.[0]?.localStorage || []).find((e) => e.name === 'token')?.value;
}
const T = {};
for (const r of ['MANAGER', 'COORDINATOR', 'TECH', 'MAGASIN', 'ADMIN_MANAGER']) T[r] = tok(r);

const PDF =
  'data:application/pdf;base64,JVBERi0xLjEKJcKlwrHDqwoxIDAgb2JqCjw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+CmVuZG9iagoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvS2lkc1szIDAgUl0vQ291bnQgMT4+CmVuZG9iagozIDAgb2JqCjw8L1R5cGUvUGFnZS9QYXJlbnQgMiAwIFI+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4KJSVFT0Y=';

async function gql(role, query) {
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T[role]}` },
    body: JSON.stringify({ query }),
  });
  const body = await resp.json().catch(() => ({}));
  return { data: body.data ?? null, errors: body.errors ?? null };
}

const client = new MongoClient(MONGO_URL);
await client.connect();
const db = client.db(MONGO_DB);

const tech = await db.collection('profiles').findOne({ username: 'tech' });
if (!tech) throw new Error('Profil « tech » introuvable');
const TECH_ID = String(tech._id);
const location = await db.collection('locations').findOne({ location_name: 'A12' });
const category = await db.collection('dicategories').findOne({});

const status = async (id) => (await db.collection('dis').findOne({ _id: id }))?.status;

let DI = null;
const fail = async (label, r, got, expected) => {
  console.error(`\n❌ ${label} : statut ${got} (attendu ${expected})`);
  for (const e of r?.errors ?? []) console.error(`   ${e.extensions?.code ?? '?'} — ${e.message}`);
  console.error(`   DI ${DI} laissée en ${got}.`);
  await client.close();
  process.exit(1);
};

// 1) Création (manager) — vraie mutation : _idnum T…, Stat + logsdis cycle 0.
const created = await gql(
  'MANAGER',
  `mutation { createDi(createDiInput: {
      title: "VARIATEUR — DI retour avec historique (QA)",
      status: "CREATED",
      typeClient: "CLIENT",
      description: "Flux d'origine complet puis retour",
      nSerie: "QA-RET-001",
      client_id: "${CLIENT_ID}",
      location_id: "${location?._id ?? ''}",
      can_be_repaired: true
    }) { _id _idnum status } }`,
);
DI = created.data?.createDi?._id;
if (!DI) {
  console.error('❌ createDi', JSON.stringify(created.errors));
  process.exit(1);
}
console.log(`✅ createDi → ${DI} (${created.data.createDi._idnum}) ${created.data.createDi.status}`);

// [libellé, rôle, mutation, statut attendu après]
const CHAIN = [
  ['manager_Pending1', 'MANAGER', `manager_Pending1(_id:"${DI}"){_id}`, 'PENDING1'],
  ['affectation diag → tech (createStat)', 'COORDINATOR',
    `createStat(createStatInput:{_idDi:"${DI}", id_tech_diag:"${TECH_ID}", notificationMessage:"default msg", location_id:"${location?._id ?? ''}"}){_idDi}`, 'PENDING1'],
  ['coordinatorSendingDiDiag', 'COORDINATOR', `coordinatorSendingDiDiag(_idDI:"${DI}"){_id}`, 'DIAGNOSTIC'],
  ['changeStatusInDiagnostic (tech démarre)', 'TECH', `changeStatusInDiagnostic(_id:"${DI}")`, 'INDIAGNOSTIC'],
  ['lapTime diag', 'TECH', `lapTimeForPauseAndGetBack(_id:"${DI}", diagTime:"00:42:00")`, 'INDIAGNOSTIC'],
  ['tech_startDiagnostic (fin diag : réparable + PDR)', 'TECH',
    `tech_startDiagnostic(_id:"${DI}", diag:{ remarque_tech_diagnostic:"Condensateur HS sur l'alimentation", contain_pdr:true, can_be_repaired:true, isErrorFromFixtronix:false, di_category_id:"${category?._id ?? ''}", array_composants:[{nameComposant:"${COMPOSANT.name}", quantity:${COMPOSANT.quantity}}] })`, 'INDIAGNOSTIC'],
  ['changeStatusMagasinEstimation', 'TECH', `changeStatusMagasinEstimation(_id:"${DI}")`, 'MagasinEstimation'],
  ['magasinTech_Pending2', 'MAGASIN', `magasinTech_Pending2(_id:"${DI}"){_id}`, 'PENDING2'],
  ['changeStatusPricing', 'COORDINATOR', `changeStatusPricing(_id:"${DI}")`, 'PRICING_DIAG'],
  ['affectinitialPrice (prix diag 150)', 'ADMIN_MANAGER', `affectinitialPrice(_id:"${DI}", price:150)`, 'PRICING_DIAG'],
  ['changeStatusNegociate1', 'ADMIN_MANAGER', `changeStatusNegociate1(_id:"${DI}")`, 'WAITING_DEVIS'],
  ['addDevis', 'MANAGER', `addDevis(_id:"${DI}", pdf:"${PDF}"){_id}`, 'WAITING_BC'],
  ['addBC', 'MANAGER', `addBC(_id:"${DI}", pdf:"${PDF}"){_id}`, 'CONFIRMATION'],
  ['magasin → coordination', 'MAGASIN', `sendComponentToConMagasinForConfirmation(_id:"${DI}"){_id}`, 'ATTENTE_CONFIRMATION_COORDINATION'],
  ['coordination confirme', 'COORDINATOR', `componentConfirmedFromCoordinator(_id:"${DI}"){_id}`, 'MAGASIN_FINALISATION'],
  ['magasin fin liste', 'MAGASIN', `changeStatusPending3(_id:"${DI}")`, 'PENDING3'],
  ['affectation répa → tech (affectForRep)', 'COORDINATOR', `affectForRep(_idDi:"${DI}", _idTech:"${TECH_ID}")`, 'PENDING3'],
  ['changeStatusRepaire', 'COORDINATOR', `changeStatusRepaire(_id:"${DI}")`, 'REPARATION'],
  ['changeStatusInRepair (tech démarre)', 'TECH', `changeStatusInRepair(_id:"${DI}")`, 'INREPARATION'],
  ['lapTime répa', 'TECH', `lapTimeForPauseAndGetBackForReaparation(_id:"${DI}", repTime:"01:15:00")`, 'INREPARATION'],
  ['tech_finishReperation', 'TECH', `tech_finishReperation(_id:"${DI}", remarque:"Condensateur remplacé, tests OK"){_id}`, 'INREPARATION'],
  ['changestatusToFinishReparation', 'TECH', `changestatusToFinishReparation(_id:"${DI}"){_id}`, 'WAITING_BL'],
  ['addBl', 'MANAGER', `addBl(_id:"${DI}", pdf:"${PDF}"){_id}`, 'WAITING_FACTURE'],
  ['addFacture', 'MANAGER', `addFacture(_id:"${DI}", pdf:"${PDF}"){_id}`, 'FINISHED'],
  ['changeStatusRetour1', 'MANAGER', `changeStatusRetour1(_id:"${DI}", reason:"Même panne revenue après 2 semaines")`, 'RETOUR1'],
];

for (const [label, role, mutation, expected] of CHAIN) {
  const r = await gql(role, `mutation { ${mutation} }`);
  const got = await status(DI);
  if (got !== expected || r.errors?.length) {
    if (got !== expected) await fail(label, r, got, expected);
    // Statut bon mais erreur GraphQL : on la montre sans s'arrêter.
    console.warn(`⚠️  ${label} → ${got} avec erreur : ${r.errors?.[0]?.message}`);
  } else {
    console.log(`✅ ${label} → ${got}`);
  }
}

const di = await db.collection('dis').findOne({ _id: DI });
const stats = await db.collection('stats').find({ _idDi: DI }).sort({ ignoreCount: 1 }).toArray();
const logs = await db.collection('logsdis').find({ _idDi: DI }).sort({ idIgnore: 1 }).toArray();
console.log(`\nDI ${di._idnum} (${DI}) — statut ${di.status}, cycle ${di.ignoreCount}`);
console.log('Historique :', (di.statusHistory ?? []).map((h) => h.status).join(' → '));
for (const s of stats) {
  console.log(`Stat cycle ${s.ignoreCount ?? 0} : diag=${s.id_tech_diag} (${s.diag_time}) répa=${s.id_tech_rep} (${s.rep_time})`);
}
for (const l of logs) {
  console.log(`logsdis cycle ${l.idIgnore} : docs=${Object.keys(l.driveDocs ?? {}).join(',') || '—'} closedAt=${l.closedAt ?? '—'}`);
}
await client.close();
