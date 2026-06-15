import { test, expect } from '../../fixtures/auth';
import { tokenFor } from '../../utils/auth';
import { gqlPost } from '../../utils/graphql';
import type { APIRequestContext } from '@playwright/test';

/**
 * Regression — DI happy-path lifecycle (validated portion).
 * Create a DI and advance it through a valid transition, asserting status at
 * each step, then soft-delete it. (Deterministic; self-contained; cleans up.)
 */

async function clientId(request: APIRequestContext, token: string) {
  const r = await gqlPost(request, `{ getAllClient { _id } }`, token);
  const id = r.data?.getAllClient?.[0]?._id;
  expect(id, 'a client exists to attach a DI to').toBeTruthy();
  return id as string;
}

test('DI create → CREATED → PENDING1 lifecycle', async ({ request }) => {
  const token = tokenFor('ADMIN_MANAGER');
  const cid = await clientId(request, token);

  const created = await gqlPost(
    request,
    `mutation { createDi(createDiInput: { title: "REG-DI-${Date.now()}", status: "CREATED", typeClient: "CLIENT", client_id: "${cid}" }) { _id status } }`,
    token,
  );
  expect(created.errors, 'createDi has no errors').toBeNull();
  const id = created.data?.createDi?._id as string;
  expect(id, 'new DI _id returned').toBeTruthy();
  expect(created.data?.createDi?.status, 'starts CREATED').toBe('CREATED');

  try {
    const moved = await gqlPost(request, `mutation { manager_Pending1(_id: "${id}") { _id status } }`, token);
    expect(moved.errors, 'manager_Pending1 has no errors').toBeNull();

    const after = await gqlPost(request, `{ getDiById(_id: "${id}") { di { _id status } } }`, token);
    expect(after.data?.getDiById?.di?.status, 'advanced to PENDING1').toBe('PENDING1');
  } finally {
    await gqlPost(request, `mutation { deleteDi(_id: "${id}") { _id isDeleted } }`, token);
  }
});
