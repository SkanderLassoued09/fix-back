import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';

/**
 * feat retour-waiting-bl — le bouton « Retour » s'ouvre désormais en phase
 * « attente BL » (WAITING_BL, juste après la réparation) au lieu du stade
 * facturé (FINISHED). Le grisage front a changé (status !== 'WAITING_BL') ;
 * ce test valide le MÉCANISME back : une DI en WAITING_BL peut réellement
 * passer par le flux retour (countIgnore → changeStatusRetour1) et atterrir
 * en RETOUR1 — le back n'imposait déjà aucune garde de statut source pour le
 * retour, ce test le PROUVE de bout en bout via l'API réelle.
 *
 * Test auto-suffisant : seed direct en base, appels GraphQL réels, assertions
 * sur le statut/ignoreCount, nettoyage exhaustif en fin de suite.
 */

const IDS = {
  fromBl: 'di-retour-wbl-e2e-frombl',
  fromBlSecond: 'di-retour-wbl-e2e-frombl2',
  fromFacture: 'di-retour-wbl-e2e-fromfacture',
  fromClosingLegacy: 'di-retour-wbl-e2e-fromclosing',
};
const ALL_IDS = Object.values(IDS);

async function seedDi(patch: {
  _id: string;
  status: string;
  ignoreCount?: number;
}): Promise<void> {
  await withDb(async (db) => {
    const ignoreCount = patch.ignoreCount ?? 0;
    await db.collection('dis').deleteOne({ _id: patch._id });
    await db.collection('stats').deleteMany({ _idDi: patch._id });
    const now = new Date();
    await db.collection('dis').insertOne({
      _id: patch._id,
      _idnum: patch._id,
      title: 'RETOUR WAITING_BL E2E — donnée de test',
      status: patch.status,
      ignoreCount,
      can_be_repaired: true,
      current_roles: [],
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('stats').insertOne({
      _id: `stat-${patch._id}`,
      _idDi: patch._id,
      ignoreCount,
      status: patch.status,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function diRow(_id: string): Promise<any> {
  return withDb(async (db) =>
    db
      .collection('dis')
      .findOne({ _id }, { projection: { status: 1, ignoreCount: 1 } }),
  );
}

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.collection('dis').deleteMany({ _id: { $in: ALL_IDS } });
    await db.collection('stats').deleteMany({ _idDi: { $in: ALL_IDS } });
    await db.collection('notifications').deleteMany({ diId: { $in: ALL_IDS } });
    await db.collection('system_events').deleteMany({ diId: { $in: ALL_IDS } });
    await db.collection('logsdis').deleteMany({ _idDi: { $in: ALL_IDS } });
  });
});

test('WAITING_BL → countIgnore + changeStatusRetour1 → RETOUR1 (retour ouvert en attente BL)', async ({
  request,
}) => {
  const _id = IDS.fromBl;
  await seedDi({ _id, status: 'WAITING_BL', ignoreCount: 0 });

  // Étape 1 — countIgnore : incrémente le compteur de retour (0 → 1).
  const bump = await gqlPost(
    request,
    `mutation { countIgnore(_idDI: "${_id}") { ignoreCount } }`,
  );
  expect(bump.errors, bump.errorText).toBeNull();
  expect(bump.data?.countIgnore?.ignoreCount).toBe(1);

  // Étape 2 — transition RETOUR1 avec motif (comme confirmRetour côté front).
  const trans = await gqlPost(
    request,
    `mutation { changeStatusRetour1(_id: "${_id}", reason: "QC réparation KO") }`,
  );
  expect(trans.errors, trans.errorText).toBeNull();

  // La DI, partie de WAITING_BL, est bien repassée en RETOUR1 (cycle 1).
  const di = await diRow(_id);
  expect(di?.status).toBe('RETOUR1');
  expect(di?.ignoreCount).toBe(1);
});

test('WAITING_BL : le retour n’exige PAS que la DI soit FINISHED (aucune garde de statut source)', async ({
  request,
}) => {
  const _id = IDS.fromBlSecond;
  await seedDi({ _id, status: 'WAITING_BL', ignoreCount: 0 });

  // Directement la transition RETOUR1 depuis WAITING_BL doit être acceptée
  // (le back ne filtre pas la source — c'est ce qui rend le nouveau grisage
  // front WAITING_BL cohérent avec le back).
  const trans = await gqlPost(
    request,
    `mutation { changeStatusRetour1(_id: "${_id}", reason: "retour depuis attente BL") }`,
  );
  expect(trans.errors, trans.errorText).toBeNull();
  expect((await diRow(_id))?.status).toBe('RETOUR1');
});

// ─── Le retour est ouvert sur TOUTE la phase de clôture, pas seulement WAITING_BL
// Le bouton était grisé en WAITING_FACTURE alors que le back l'accepte : la
// règle front était une liste de deux valeurs codée en dur dans le template.
test('WAITING_FACTURE → countIgnore + changeStatusRetour1 → RETOUR1', async ({
  request,
}) => {
  const _id = IDS.fromFacture;
  await seedDi({ _id, status: 'WAITING_FACTURE', ignoreCount: 0 });

  const bump = await gqlPost(
    request,
    `mutation { countIgnore(_idDI: "${_id}") { ignoreCount } }`,
  );
  expect(bump.errors, bump.errorText).toBeNull();
  expect(bump.data?.countIgnore?.ignoreCount).toBe(1);

  const trans = await gqlPost(
    request,
    `mutation { changeStatusRetour1(_id: "${_id}", reason: "facture à refaire") }`,
  );
  expect(trans.errors, trans.errorText).toBeNull();
  expect((await diRow(_id))?.status).toBe('RETOUR1');
});

test('CLOSING (valeur legacy) accepte aussi le retour', async ({ request }) => {
  const _id = IDS.fromClosingLegacy;
  await seedDi({ _id, status: 'CLOSING', ignoreCount: 0 });

  const trans = await gqlPost(
    request,
    `mutation { changeStatusRetour1(_id: "${_id}", reason: "legacy") }`,
  );
  expect(trans.errors, trans.errorText).toBeNull();
  expect((await diRow(_id))?.status).toBe('RETOUR1');
});
