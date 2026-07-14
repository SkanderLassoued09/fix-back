import { test, expect } from '@playwright/test';
import { tokenFor } from '../utils/auth';
import { gqlPost } from '../utils/graphql';
import { withDb } from '../utils/mongo';
import { nextDiIdnum, anyClientId } from '../utils/di-seed';

/**
 * Status-history = the SINGLE source of truth for the "Contrôle du Flow" per-step
 * dates. Two guarantees, driven live:
 *
 *  1. EVERY status transition (both the workflow-engine ones and the direct
 *     `$set` ones) appends a `{status, at}` entry via the central Mongoose hook
 *     — none forgotten. (Fixes the missing Diagnostic/Magasin dates.)
 *  2. The coordinator query resolves actor ids → NAMES: never a raw ObjectId.
 *
 * Run: MONGO_DB=fixtronixproddb npx playwright test --config=playwright.e2e.config.ts di-status-history
 */

const TAG = Date.now().toString(36);
let token = '';

const historyStatuses = async (diId: string): Promise<string[]> =>
  withDb(async (db) => {
    const di: any = await db.collection('dis').findOne({ _id: diId });
    return (di?.statusHistory ?? []).map((h: any) => h.status);
  });

test.beforeAll(() => {
  token = tokenFor('ADMIN_MANAGER');
});

test('every transition appends to statusHistory (single source, none forgotten)', async ({ request }) => {
  const id = `DI_hist_${TAG}`;
  // Seed at INDIAGNOSTIC via the raw driver (bypasses hooks → empty history),
  // then drive real mutations so the Mongoose status-change hook fires.
  await withDb(async (db) => {
    await db.collection('dis').insertOne({
      _id: id,
      _idnum: await nextDiIdnum(db),
      title: 'QA status-history',
      status: 'INDIAGNOSTIC',
      can_be_repaired: true,
      contain_pdr: false,
      client_id: await anyClientId(db),
      isDeleted: false,
      array_composants: [],
      current_roles: ['Tech'],
      ignoreCount: 0,
      statusHistory: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('stats').insertOne({
      _id: `STAT_${id}`,
      _idDi: id,
      diRef: id,
      status: 'INDIAGNOSTIC',
      ignoreCount: 0,
      retour_count: 0,
      pauseLogs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  try {
    // Transition 1 (workflow engine): INDIAGNOSTIC → PENDING2
    await gqlPost(request, `mutation { magasinTech_Pending2(_id: "${id}") { _id status } }`, token);
    // Transition 2 (direct $set): PENDING2 → PRICING
    await gqlPost(request, `mutation { changeStatusPricing(_id: "${id}") }`, token);

    const hist = await historyStatuses(id);
    // Both transitions must be recorded, in order — neither forgotten.
    expect(hist, `history=${JSON.stringify(hist)}`).toContain('PENDING2');
    expect(hist, `history=${JSON.stringify(hist)}`).toContain('PRICING');
    expect(hist.indexOf('PENDING2')).toBeLessThan(hist.indexOf('PRICING'));
    // Each entry carries a real date.
    const entries = await withDb(async (db) =>
      ((await db.collection('dis').findOne({ _id: id })) as any)?.statusHistory ?? [],
    );
    expect(entries.every((e: any) => !!e.at)).toBeTruthy();
  } finally {
    await withDb(async (db) => {
      await db.collection('dis').deleteOne({ _id: id });
      await db.collection('stats').deleteOne({ _id: `STAT_${id}` });
    });
  }
});

test('coordinator query never returns a raw ObjectId for actor fields', async ({ request }) => {
  const r = await gqlPost(
    request,
    `{ get_coordinatorDI(paginationConfig: { first: 0, rows: 40 }) {
        di { _idnum pricingRequestSentBy componentsConfirmedBy createdBy } } }`,
    token,
  );
  const rows: any[] = r.data?.get_coordinatorDI?.di ?? [];
  const isObjectId = (v: any) => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v.trim());
  const offenders = rows
    .flatMap((d) => [
      { f: 'pricingRequestSentBy', v: d.pricingRequestSentBy, id: d._idnum },
      { f: 'componentsConfirmedBy', v: d.componentsConfirmedBy, id: d._idnum },
      { f: 'createdBy', v: d.createdBy, id: d._idnum },
    ])
    .filter((x) => isObjectId(x.v));
  expect(rows.length, 'coordinator returned rows').toBeGreaterThan(0);
  expect(offenders, `raw ObjectIds leaked: ${JSON.stringify(offenders)}`).toHaveLength(0);
});
