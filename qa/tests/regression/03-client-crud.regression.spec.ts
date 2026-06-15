import { test, expect } from '../../fixtures/auth';
import { tokenFor } from '../../utils/auth';
import { gqlPost } from '../../utils/graphql';
import type { APIRequestContext } from '@playwright/test';

/**
 * Regression — client CRUD (create → search → soft-delete) at the API layer.
 * Deterministic and self-cleaning. Also pins the consistent behavior that
 * searchClient EXCLUDES soft-deleted clients (a just-deleted client → 0 matches).
 */

async function searchCount(request: APIRequestContext, token: string, value: string) {
  const r = await gqlPost(
    request,
    `{ searchClient(paginationConfig: { first: 0, rows: 20 }, search: { field: "first_name", value: "${value}" }) { totalClientRecord clientRecords { _id first_name } } }`,
    token,
  );
  return { total: r.data?.searchClient?.totalClientRecord ?? 0, records: r.data?.searchClient?.clientRecords ?? [] };
}

test('client create → searchable → delete → no longer searchable', async ({ request }) => {
  const token = tokenFor('ADMIN_MANAGER');
  const first = `REGCLI${Date.now()}`;

  const created = await gqlPost(
    request,
    `mutation { createClient(createClientInput: {
        first_name: "${first}", last_name: "Reg", region: "TUNIS",
        address: "Addr", email: "reg@example.com", phone: "12345678"
     }) { _id } }`,
    token,
  );
  expect(created.errors, 'createClient has no errors').toBeNull();
  const id = created.data?.createClient?._id as string;
  expect(id, 'new client _id').toBeTruthy();

  const found = await searchCount(request, token, first);
  expect(found.total, 'created client is searchable').toBeGreaterThanOrEqual(1);
  expect(found.records.some((c: any) => c.first_name === first), 'search returns the created client').toBeTruthy();

  const removed = await gqlPost(request, `mutation { removeClient(_id: "${id}") { isDeleted } }`, token);
  expect(removed.data?.removeClient?.isDeleted, 'soft-deleted').toBe(true);

  const afterDelete = await searchCount(request, token, first);
  expect(afterDelete.total, 'soft-deleted client is excluded from search').toBe(0);
});
