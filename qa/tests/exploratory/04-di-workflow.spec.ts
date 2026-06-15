import { test, expect } from '../../fixtures/auth';
import { tokenFor } from '../../utils/auth';
import { gqlPost } from '../../utils/graphql';
import type { APIRequestContext } from '@playwright/test';

/**
 * Area 4 + 5 — DI create & workflow (core domain), driven via the GraphQL API.
 *
 * Rationale: transition VALIDITY and role enforcement live in the backend (the
 * soft-validation workflow engine + mostly-unguarded resolvers). Driving the API
 * directly is the robust way to test the H1/H2 hypotheses from the strategy:
 *   H1 — invalid/skipped transitions are NOT rejected (soft validation, D2)
 *   H2 — wrong-role transitions are NOT rejected (unguarded resolvers, S3)
 * Each test creates its OWN throwaway DI and soft-deletes it at the end.
 */

const ADMIN = () => tokenFor('ADMIN_MANAGER');
const TECH = () => tokenFor('TECH');

async function firstClientId(request: APIRequestContext, token: string): Promise<string> {
  const r = await gqlPost(request, `{ getAllClient { _id first_name last_name } }`, token);
  const id = r.data?.getAllClient?.[0]?._id;
  expect(id, 'a seed client exists to attach the DI to').toBeTruthy();
  return id;
}

async function makeDi(request: APIRequestContext, token: string, title: string, clientId: string) {
  return gqlPost(
    request,
    `mutation { createDi(createDiInput: {
        title: "${title}", status: "CREATED", typeClient: "CLIENT", client_id: "${clientId}"
     }) { _id status } }`,
    token,
  );
}

async function diStatus(request: APIRequestContext, token: string, id: string): Promise<string | undefined> {
  const r = await gqlPost(request, `{ getDiById(_id: "${id}") { di { _id status } } }`, token);
  return r.data?.getDiById?.di?.status;
}

async function deleteDi(request: APIRequestContext, token: string, id: string) {
  await gqlPost(request, `mutation { deleteDi(_id: "${id}") { _id isDeleted } }`, token);
}

test.describe('Area 4/5 — DI create & workflow (API)', () => {
  test('A5.1 create a DI → status CREATED (no GraphQL errors)', async ({ request }) => {
    const token = ADMIN();
    const clientId = await firstClientId(request, token);
    const res = await makeDi(request, token, `QA-DI-${Date.now()}`, clientId);

    expect(res.errors, 'createDi has no GraphQL errors').toBeNull();
    const id = res.data?.createDi?._id;
    expect(id, 'server returned a new DI _id').toBeTruthy();
    expect(res.data?.createDi?.status, 'new DI starts in CREATED').toBe('CREATED');

    await deleteDi(request, token, id);
  });

  test('A5.2 valid transition CREATED → PENDING1 (manager_Pending1) succeeds', async ({ request }) => {
    const token = ADMIN();
    const clientId = await firstClientId(request, token);
    const id = (await makeDi(request, token, `QA-DI-${Date.now()}`, clientId)).data.createDi._id;

    const res = await gqlPost(request, `mutation { manager_Pending1(_id: "${id}") { _id status } }`, token);
    expect(res.errors, 'manager_Pending1 has no errors').toBeNull();
    expect(await diStatus(request, token, id), 'DI advanced to PENDING1').toBe('PENDING1');

    await deleteDi(request, token, id);
  });

  test('H1 — invalid/skipped transition is NOT rejected (confirms soft validation, D2)', async ({ request }) => {
    const token = ADMIN();
    const clientId = await firstClientId(request, token);
    const id = (await makeDi(request, token, `QA-DI-H1-${Date.now()}`, clientId)).data.createDi._id;

    // From CREATED, jump straight to PENDING3 (skipping diagnostic/magasin/pricing/nego).
    // A real state machine would reject this; the soft engine should accept it.
    const res = await gqlPost(request, `mutation { changeStatusPending3(_id: "${id}") }`, token);
    const after = await diStatus(request, token, id);

    await test.info().attach('H1-skip-transition.json', {
      body: JSON.stringify({ errors: res.errors, statusAfter: after }, null, 2),
      contentType: 'application/json',
    });

    expect(res.errors, 'no error returned for the illegal skip').toBeNull();
    expect(after, 'DI was allowed to skip CREATED → PENDING3').toBe('PENDING3');

    await deleteDi(request, token, id);
  });

  test('H2 — a TECH token can perform a Manager-only transition (confirms unguarded, S3)', async ({ request }) => {
    const admin = ADMIN();
    const clientId = await firstClientId(request, admin);
    const id = (await makeDi(request, admin, `QA-DI-H2-${Date.now()}`, clientId)).data.createDi._id;

    // manager_Pending1 is a Manager/Admin-only step per STATUS_DI, but the resolver
    // is unguarded — a TECH token (or none) succeeds.
    const res = await gqlPost(request, `mutation { manager_Pending1(_id: "${id}") { _id status } }`, TECH());

    expect(res.errors, 'no authorization error for a wrong-role transition').toBeNull();
    expect(await diStatus(request, admin, id), 'TECH drove a manager-only transition').toBe('PENDING1');

    await deleteDi(request, admin, id);
  });
});
