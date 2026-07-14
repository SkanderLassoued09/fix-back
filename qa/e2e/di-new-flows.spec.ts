import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { tokenFor } from '../utils/auth';
import { gqlPost } from '../utils/graphql';
import { withDb } from '../utils/mongo';
import { nextDiIdnum, anyClientId } from '../utils/di-seed';

/**
 * NEW-FLOW arcs added on feature/reunion-lifecycle-jira, driven live against the
 * running backend (API-level, not ownership-guarded so ADMIN_MANAGER can drive
 * them). Every seeded doc is tagged + hard-deleted afterwards.
 *
 *  1. Non-repairable (original flow) → PENDING2 (bills the diagnostic, Magasin
 *     is skipped).
 *  2. « Renvoyer au diagnostic » : PRICING → PENDING1 is ALLOWED (new arc).
 *  3. The same back-arc is REFUSED from a non-PRICING source (PENDING2), proving
 *     it did not open PENDING1 to arbitrary states.
 *
 * Run with MONGO_DB matching the running app (fixtronixproddb):
 *   MONGO_DB=fixtronixproddb npx playwright test --config=playwright.e2e.config.ts di-new-flows
 */

const TAG = Date.now().toString(36);
let token = '';

const statusOf = async (api: APIRequestContext, id: string) =>
  (await gqlPost(api, `{ getDiById(_id: "${id}") { di { status } } }`, token))
    .data?.getDiById?.di?.status;

async function seedDi(id: string, status: string, extra: Record<string, unknown> = {}) {
  await withDb(async (db) => {
    await db.collection('dis').insertOne({
      _id: id,
      _idnum: await nextDiIdnum(db),
      title: 'QA new-flow',
      status,
      can_be_repaired: true,
      contain_pdr: false,
      client_id: await anyClientId(db),
      isDeleted: false,
      array_composants: [],
      current_roles: ['Manager', 'Admin_Manager'],
      ignoreCount: 0,
      statusUpdatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    });
    await db.collection('stats').insertOne({
      _id: `STAT_${id}`,
      _idDi: id,
      diRef: id,
      status,
      ignoreCount: 0,
      retour_count: 0,
      pauseLogs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
}

async function cleanup(id: string) {
  await withDb(async (db) => {
    await db.collection('dis').deleteOne({ _id: id });
    await db.collection('stats').deleteOne({ _id: `STAT_${id}` });
  });
}

test.beforeAll(() => {
  token = tokenFor('ADMIN_MANAGER');
});

test('non-repairable (original flow) → PENDING2, Magasin skipped', async ({ request }) => {
  const id = `DI_nr_${TAG}`;
  await seedDi(id, 'INDIAGNOSTIC', { can_be_repaired: false });
  try {
    const r = await gqlPost(
      request,
      `mutation { changestatusToFinishReparation(_id: "${id}") { _id status } }`,
      token,
    );
    const after = await statusOf(request, id);
    expect(r.errors ?? [], JSON.stringify(r.errors)).toHaveLength(0);
    expect(after, 'non-repairable original flow bills the diagnostic → PENDING2').toBe(
      'PENDING2',
    );
  } finally {
    await cleanup(id);
  }
});

test('« Renvoyer au diagnostic » : NON-REPARABLE PRICING → PENDING1 is allowed', async ({ request }) => {
  const id = `DI_back_${TAG}`;
  await seedDi(id, 'PRICING', { can_be_repaired: false });
  try {
    const r = await gqlPost(
      request,
      `mutation { sendDiBackToDiagnostic(_id: "${id}") { _id status } }`,
      token,
    );
    const after = await statusOf(request, id);
    expect(r.errors ?? [], JSON.stringify(r.errors)).toHaveLength(0);
    expect(after, 'PRICING → PENDING1 (coordinator re-assigns)').toBe('PENDING1');
  } finally {
    await cleanup(id);
  }
});

test('« Renvoyer au diagnostic » is REFUSED for a REPARABLE DI (normal pricing)', async ({ request }) => {
  const id = `DI_backrep_${TAG}`;
  await seedDi(id, 'PRICING', { can_be_repaired: true });
  try {
    const r = await gqlPost(
      request,
      `mutation { sendDiBackToDiagnostic(_id: "${id}") { _id status } }`,
      token,
    );
    const code = r.errors?.[0]?.extensions?.code;
    const after = await statusOf(request, id);
    expect(code, 'only a non-repairable DI may be sent back').toBe(
      'BACK_TO_DIAG_NOT_NON_REPARABLE',
    );
    expect(after, 'reparable DI stays in PRICING').toBe('PRICING');
  } finally {
    await cleanup(id);
  }
});

test('« Renvoyer au diagnostic » from PENDING2 is REFUSED (BAD_REQUEST, unchanged)', async ({ request }) => {
  const id = `DI_backbad_${TAG}`;
  // Non-repairable so it clears the business guard and hits the transition guard.
  await seedDi(id, 'PENDING2', { can_be_repaired: false });
  try {
    const r = await gqlPost(
      request,
      `mutation { sendDiBackToDiagnostic(_id: "${id}") { _id status } }`,
      token,
    );
    const code = r.errors?.[0]?.extensions?.code;
    const after = await statusOf(request, id);
    expect(code, 'only PRICING (and CREATED) may reach PENDING1').toBe('BAD_REQUEST');
    expect(code, 'no 500').not.toBe('INTERNAL_SERVER_ERROR');
    expect(after, 'DI stays PENDING2 on a refused transition').toBe('PENDING2');
  } finally {
    await cleanup(id);
  }
});
