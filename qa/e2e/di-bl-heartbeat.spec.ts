import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';

/**
 * Alerte BL « cœur qui bat » — vérifie le back : dès l'ENTRÉE en WAITING_BL
 * (fin de réparation), une notification PERSISTANTE `DI_DOC_BL_PENDING` est
 * créée immédiatement (avant : n'existait qu'au prochain passage du cron).
 * Le front la fait battre + boucle le son jusqu'à l'upload du BL.
 */

const ID = 'DI_blheartbeat-e2e';

test.beforeAll(async () => {
  await withDb(async (db) => {
    const now = new Date();
    await db.collection('dis').deleteOne({ _id: ID });
    await db.collection('stats').deleteMany({ _idDi: ID });
    await db.collection('notifications').deleteMany({ diId: ID });
    await db.collection('system_events').deleteMany({ diId: ID });
    // DI en réparation, sans BL — « Fin réparation » l'enverra en WAITING_BL.
    await db.collection('dis').insertOne({
      _id: ID,
      _idnum: ID,
      title: 'BL HEARTBEAT E2E',
      status: 'INREPARATION',
      ignoreCount: 0,
      isDeleted: false,
      current_roles: ['Tech'],
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('stats').insertOne({
      _id: `stat-${ID}`,
      _idDi: ID,
      ignoreCount: 0,
      status: 'INREPARATION',
      createdAt: now,
      updatedAt: now,
    });
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.collection('dis').deleteOne({ _id: ID });
    await db.collection('stats').deleteMany({ _idDi: ID });
    await db.collection('notifications').deleteMany({ diId: ID });
    await db.collection('system_events').deleteMany({ diId: ID });
  });
});

async function blPendingCount(): Promise<number> {
  return withDb((db) =>
    db.collection('notifications').countDocuments({ diId: ID, type: 'DI_DOC_BL_PENDING' }),
  );
}

test('entering WAITING_BL creates a persistent DI_DOC_BL_PENDING notification immediately', async ({ request }) => {
  expect(await blPendingCount()).toBe(0);

  const r = await gqlPost(
    request,
    `mutation { changestatusToFinishReparation(_id: "${ID}") { _id status } }`,
  );
  expect(r.errors, r.errorText).toBeNull();

  const status = await withDb((db) =>
    db.collection('dis').findOne({ _id: ID }, { projection: { status: 1 } }),
  );
  expect(status?.status).toBe('WAITING_BL');

  // La relance battante existe DÈS l'entrée (≥1 destinataire de coordination).
  expect(await blPendingCount()).toBeGreaterThan(0);
});
