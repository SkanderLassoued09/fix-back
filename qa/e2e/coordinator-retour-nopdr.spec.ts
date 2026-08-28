import { test, expect } from '@playwright/test';
import { gql } from './_helpers';
import { withDb } from '../utils/mongo';
import { tokenFor } from '../utils/auth';

/**
 * Raccourci RETOUR sans PDR (erreur Fixtronix) + envoi en réparation avec devis.
 *
 * Vérifié de bout en bout via le VRAI resolver/service/DB (API GraphQL) :
 *  A. RETOUR (ignoreCount>0) sans PDR (snapshot LogsDi) + erreur Fixtronix →
 *     changeStatusMagasinEstimation route en PENDING3 et pose le marqueur
 *     needsDevisBeforeRepair (magasin + tarification sautés).
 *  B. La coordinatrice est AUTORISÉE mais le devis est BLOQUANT : sans devis, la
 *     garde métier refuse (message « Devis obligatoire ») et le statut ne bouge pas.
 *  C. Le rôle TECH est REFUSÉ par la garde de rôle (appel API direct compris) —
 *     refus AVANT la garde devis (pas le même message).
 *
 * Setup direct en base (withDb) car l'état retour+diagnostic n'est pas
 * exprimable par une seule mutation. Nettoyage en afterAll.
 */

const TAG = Date.now().toString(36);
const TECH_ID = '69fb49a8fbdfcb7ca81bed0e';

async function seedDi(
  suffix: string,
  di: Record<string, any>,
  statExtra: Record<string, any> = {},
  logExtra: Record<string, any> | null = null,
) {
  const diId = `DI_rnp_${TAG}_${suffix}`;
  const statId = `STAT_rnp_${TAG}_${suffix}`;
  const idnum = `RNP-${TAG}-${suffix}`;
  await withDb(async (db) => {
    const client = await db
      .collection('clients')
      .findOne({ isDeleted: { $ne: true } });
    await db.collection('dis').insertOne({
      _id: diId,
      _idnum: idnum,
      title: `QA RNP ${suffix}`,
      description: 'retour-nopdr shortcut',
      client_id: client?._id ?? null,
      createdBy: TECH_ID,
      location_id: null,
      current_workers_ids: [TECH_ID],
      isDeleted: false,
      statusUpdatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...di,
    });
    await db.collection('stats').insertOne({
      _id: statId,
      _idDi: diId,
      diRef: diId,
      id_tech_diag: TECH_ID,
      id_tech_rep: TECH_ID,
      diag_time: '00:00:00',
      rep_time: '',
      retour_count: 0,
      pauseLogs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...statExtra,
    });
    if (logExtra) {
      await db.collection('logsdis').insertOne({
        _idDi: diId,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...logExtra,
      });
    }
  });
  return { diId, statId, idnum };
}

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.collection('dis').deleteMany({ _id: { $regex: `_rnp_${TAG}_` } });
    await db.collection('stats').deleteMany({ _id: { $regex: `_rnp_${TAG}_` } });
    await db
      .collection('logsdis')
      .deleteMany({ _idDi: { $regex: `_rnp_${TAG}_` } });
  });
});

test('A — RETOUR sans PDR (cycle) + Fixtronix → PENDING3 + needsDevisBeforeRepair', async ({
  request,
}) => {
  const s = await seedDi(
    'A',
    {
      // DI live : contain_pdr PÉRIMÉ du cycle 0 (doit être ignoré au profit du log).
      status: 'INDIAGNOSTIC',
      ignoreCount: 1,
      contain_pdr: true,
      array_composants: [{ nameComposant: 'stale', quantity: 1 }],
      can_be_repaired: true,
      current_roles: ['Tech'],
      needsDevisBeforeRepair: false,
    },
    { status: 'INDIAGNOSTIC', ignoreCount: 1 },
    // Snapshot du cycle retour : aucune pièce + erreur Fixtronix.
    { idIgnore: 1, contain_pdr: false, array_composants: [], isErrorFromFixtronix: true },
  );

  const r = await gql(
    request,
    tokenFor('TECH'),
    `mutation { changeStatusMagasinEstimation(_id: "${s.diId}") }`,
  );
  expect(JSON.stringify(r.errors)).toBe('[]');

  const di = await withDb((db) =>
    db.collection('dis').findOne({ _id: s.diId }),
  );
  expect(di?.status).toBe('PENDING3');
  expect(di?.needsDevisBeforeRepair).toBe(true);
});

test('B — coordinatrice autorisée mais devis BLOQUANT (statut inchangé)', async ({
  request,
}) => {
  const s = await seedDi(
    'B',
    {
      status: 'PENDING3',
      ignoreCount: 1,
      needsDevisBeforeRepair: true,
      current_roles: ['Coordinator'],
    },
    { status: 'PENDING3', ignoreCount: 1 },
  );

  const r = await gql(
    request,
    tokenFor('COORDINATOR'),
    `mutation { coordinatorSendToRepairWithDevis(_id: "${s.diId}", repTechId: "${TECH_ID}", pdf: "") }`,
  );
  // Rôle coordinatrice PASSÉ → on atteint la garde métier devis.
  expect(r.errors.length).toBeGreaterThan(0);
  expect(JSON.stringify(r.errors)).toMatch(/Devis obligatoire/);

  const di = await withDb((db) =>
    db.collection('dis').findOne({ _id: s.diId }),
  );
  expect(di?.status).toBe('PENDING3'); // pas d'envoi
});

test('C — rôle TECH REFUSÉ par la garde de rôle (avant la garde devis)', async ({
  request,
}) => {
  const s = await seedDi(
    'C',
    {
      status: 'PENDING3',
      ignoreCount: 1,
      needsDevisBeforeRepair: true,
      current_roles: ['Coordinator'],
    },
    { status: 'PENDING3', ignoreCount: 1 },
  );

  const r = await gql(
    request,
    tokenFor('TECH'),
    `mutation { coordinatorSendToRepairWithDevis(_id: "${s.diId}", repTechId: "${TECH_ID}", pdf: "") }`,
  );
  expect(r.errors.length).toBeGreaterThan(0);
  // Refus de rôle AVANT la garde devis → PAS le message « Devis obligatoire ».
  expect(JSON.stringify(r.errors)).not.toMatch(/Devis obligatoire/);
  expect(
    r.code === 'FORBIDDEN' ||
      /[Ff]orbidden|autoris/.test(JSON.stringify(r.errors)),
  ).toBeTruthy();

  const di = await withDb((db) =>
    db.collection('dis').findOne({ _id: s.diId }),
  );
  expect(di?.status).toBe('PENDING3'); // pas d'envoi
});
