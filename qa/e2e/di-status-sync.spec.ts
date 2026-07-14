import { test, expect } from '@playwright/test';
import { tokenFor } from '../utils/auth';
import { gqlPost } from '../utils/graphql';
import { withDb } from '../utils/mongo';
import { nextDiIdnum, anyClientId } from '../utils/di-seed';

/**
 * Status-divergence regression (T281 / T282).
 *
 * The Tech list (`getDiForTech`) renders `Stat.status`; the Coordinator list
 * (`get_coordinatorDI`) renders `Di.status`. The MAGASIN_TECH_TO_PENDING2
 * transition used to update ONLY Di.status → the same DI showed PENDING2 to the
 * coordinator but stayed INDIAGNOSTIC on the tech side. This drives the real
 * mutation live and asserts BOTH fields land on PENDING2 (single, coherent
 * status for both views).
 *
 * Run:
 *   MONGO_DB=fixtronixproddb npx playwright test --config=playwright.e2e.config.ts di-status-sync
 */

const TAG = Date.now().toString(36);
let token = '';

const statFromDb = async (diId: string) =>
  withDb(async (db) => (await db.collection('stats').findOne({ _idDi: diId }))?.status);

test.beforeAll(() => {
  token = tokenFor('ADMIN_MANAGER');
});

test('INDIAGNOSTIC → PENDING2 keeps Di.status and Stat.status in sync', async ({ request }) => {
  const id = `DI_sync_${TAG}`;
  await withDb(async (db) => {
    await db.collection('dis').insertOne({
      _id: id,
      _idnum: await nextDiIdnum(db),
      title: 'QA status-sync',
      status: 'INDIAGNOSTIC',
      can_be_repaired: true,
      contain_pdr: false,
      client_id: await anyClientId(db),
      isDeleted: false,
      array_composants: [],
      current_roles: ['Tech'],
      ignoreCount: 0,
      statusUpdatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('stats').insertOne({
      _id: `STAT_${id}`,
      _idDi: id,
      diRef: id,
      status: 'INDIAGNOSTIC', // tech side, must follow the DI to PENDING2
      ignoreCount: 0,
      retour_count: 0,
      pauseLogs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  try {
    const r = await gqlPost(
      request,
      `mutation { magasinTech_Pending2(_id: "${id}") { _id status } }`,
      token,
    );
    expect(r.errors ?? [], JSON.stringify(r.errors)).toHaveLength(0);

    // Coordinator view source (Di.status)
    const diStatus = (
      await gqlPost(request, `{ getDiById(_id: "${id}") { di { status } } }`, token)
    ).data?.getDiById?.di?.status;
    // Tech view source (Stat.status)
    const statStatus = await statFromDb(id);

    expect(diStatus, 'Di.status (coordinator view) → PENDING2').toBe('PENDING2');
    expect(statStatus, 'Stat.status (tech view) → PENDING2, no divergence').toBe(
      'PENDING2',
    );
    expect(statStatus, 'both views show the SAME status').toBe(diStatus);
  } finally {
    await withDb(async (db) => {
      await db.collection('dis').deleteOne({ _id: id });
      await db.collection('stats').deleteOne({ _id: `STAT_${id}` });
    });
  }
});
