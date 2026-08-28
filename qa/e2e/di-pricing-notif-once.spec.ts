import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';

/**
 * Item 3 — la notification « Prix à fixer » ne doit sonner QU'À la vraie entrée
 * en PRICING_DIAG, pas à chaque clic. On amène une DI en PENDING2, on appelle
 * changeStatusPricing DEUX fois, et on vérifie qu'UN SEUL event DI_PRICING est
 * créé (le 2e appel, DI déjà en PRICING_DIAG, n'émet plus).
 */

const ID = 'DI_pricing-notif-e2e';

test.beforeAll(async () => {
  await withDb(async (db) => {
    const now = new Date();
    await db.collection('dis').deleteOne({ _id: ID });
    await db.collection('stats').deleteMany({ _idDi: ID });
    await db.collection('system_events').deleteMany({ diId: ID });
    await db.collection('notifications').deleteMany({ diId: ID });
    await db.collection('dis').insertOne({
      _id: ID,
      _idnum: ID,
      title: 'PRICING NOTIF ONCE E2E',
      status: 'PENDING2',
      ignoreCount: 0,
      isDeleted: false,
      current_roles: ['Coordinator'],
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('stats').insertOne({
      _id: `stat-${ID}`,
      _idDi: ID,
      ignoreCount: 0,
      status: 'PENDING2',
      createdAt: now,
      updatedAt: now,
    });
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.collection('dis').deleteOne({ _id: ID });
    await db.collection('stats').deleteMany({ _idDi: ID });
    await db.collection('system_events').deleteMany({ diId: ID });
    await db.collection('notifications').deleteMany({ diId: ID });
  });
});

const pricing = () => `mutation { changeStatusPricing(_id: "${ID}") }`;

async function pricingEventCount(): Promise<number> {
  return withDb((db) =>
    db.collection('system_events').countDocuments({ diId: ID, type: 'DI_PRICING' }),
  );
}

test('pressing pricing twice emits DI_PRICING exactly once', async ({ request }) => {
  expect(await pricingEventCount()).toBe(0);

  const r1 = await gqlPost(request, pricing());
  expect(r1.errors, r1.errorText).toBeNull();
  expect(await pricingEventCount()).toBe(1); // vraie entrée → 1 event

  // 2e clic alors que la DI est déjà en PRICING_DIAG → aucun nouvel event.
  const r2 = await gqlPost(request, pricing());
  expect(r2.errors, r2.errorText).toBeNull();
  expect(await pricingEventCount()).toBe(1); // toujours 1, pas de re-notification

  const status = await withDb((db) =>
    db.collection('dis').findOne({ _id: ID }, { projection: { status: 1 } }),
  );
  expect(status?.status).toBe('PRICING_DIAG');
});
