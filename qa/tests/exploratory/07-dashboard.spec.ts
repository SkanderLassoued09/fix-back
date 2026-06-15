import { test, expect } from '../../fixtures/auth';
import { tokenFor } from '../../utils/auth';
import { gqlPost } from '../../utils/graphql';
import type { APIRequestContext } from '@playwright/test';

/**
 * Area 9 — Dashboard KPIs & cross-screen consistency (H3).
 * Verifies the dashboardKpi payload is well-formed/sane, and that getStatusCount
 * (the number the lists/badges rely on) stays consistent as a DI is created and
 * transitioned — i.e. counts don't desync from actions.
 */

const ADMIN = () => tokenFor('ADMIN_MANAGER');

async function statusCounts(request: APIRequestContext, token: string): Promise<Record<string, number>> {
  const r = await gqlPost(request, `{ getStatusCount { status count } }`, token);
  const map: Record<string, number> = {};
  for (const s of r.data?.getStatusCount ?? []) map[s.status] = s.count;
  return map;
}

test('A9.1 dashboardKpi returns a well-formed, internally sane payload', async ({ request }) => {
  const r = await gqlPost(
    request,
    `{ dashboardKpi {
        atelier { tauxClotures tauxEnCours nbEnCours }
        delais { tatMoyenJours tauxStagnant delaiMoyenStatutJours }
        volume { nbRecus nbClotures nbEnCours nbRetours }
        finance { tauxFacturation caFacture }
     } }`,
    ADMIN(),
  );
  expect(r.errors, 'dashboardKpi has no GraphQL errors').toBeNull();
  const k = r.data?.dashboardKpi;
  expect(k?.atelier, 'atelier section present').toBeTruthy();
  expect(k?.volume, 'volume section present').toBeTruthy();

  // Internal sanity: counts are non-negative and you can't close more than received.
  for (const f of ['nbRecus', 'nbClotures', 'nbEnCours', 'nbRetours'] as const) {
    expect(k.volume[f], `volume.${f} is a non-negative number`).toBeGreaterThanOrEqual(0);
  }
  expect(k.volume.nbClotures, 'closed ≤ received').toBeLessThanOrEqual(k.volume.nbRecus);
});

test('A9.2 getStatusCount stays consistent across create → transition (H3)', async ({ request }) => {
  const token = ADMIN();
  const clientId = (await gqlPost(request, `{ getAllClient { _id } }`, token)).data?.getAllClient?.[0]?._id;
  expect(clientId, 'a client exists').toBeTruthy();

  const before = await statusCounts(request, token);
  const created0 = before['CREATED'] ?? 0;
  const pending0 = before['PENDING1'] ?? 0;

  const diId = (
    await gqlPost(
      request,
      `mutation { createDi(createDiInput: { title: "QA-KPI-${Date.now()}", status: "CREATED", typeClient: "CLIENT", client_id: "${clientId}" }) { _id } }`,
      token,
    )
  ).data?.createDi?._id;
  expect(diId, 'DI created').toBeTruthy();

  try {
    const afterCreate = await statusCounts(request, token);
    expect(afterCreate['CREATED'] ?? 0, 'CREATED count +1 after createDi').toBe(created0 + 1);

    await gqlPost(request, `mutation { manager_Pending1(_id: "${diId}") { _id status } }`, token);
    const afterMove = await statusCounts(request, token);
    expect(afterMove['CREATED'] ?? 0, 'CREATED count back to baseline after transition').toBe(created0);
    expect(afterMove['PENDING1'] ?? 0, 'PENDING1 count +1 after transition').toBe(pending0 + 1);
  } finally {
    await gqlPost(request, `mutation { deleteDi(_id: "${diId}") { _id isDeleted } }`, token);
  }
});
