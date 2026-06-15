import { test, expect, authFile } from '../../fixtures/auth';
import { tokenFor } from '../../utils/auth';
import { gqlPost } from '../../utils/graphql';

/**
 * Area 6 — Search / filter / pagination (Clients list as representative).
 *
 * Self-seeds its own client via the API so it does not depend on seed-data state
 * (the seed's clients appear to be soft-deleted: findAllClient returns 0 while
 * getAllClient still returns rows — logged as a finding). Sorting is not offered
 * on this table (no sortable headers), so it is noted, not tested.
 */

test.use({ storageState: authFile('ADMIN_MANAGER') });
const LIST_URL = '/clients/client/client-list';

const firstFilter = (page: import('@playwright/test').Page) =>
  page.locator('input[placeholder="Chercher..."]').first(); // Prénom (first_name) column

async function seedClient(request: import('@playwright/test').APIRequestContext, first: string) {
  const token = tokenFor('ADMIN_MANAGER');
  const r = await gqlPost(
    request,
    `mutation { createClient(createClientInput: {
        first_name: "${first}", last_name: "Auto", region: "TUNIS",
        address: "QA Addr", email: "qa@example.com", phone: "12345678"
     }) { _id } }`,
    token,
  );
  const id = r.data?.createClient?._id;
  expect(id, 'seed client created via API').toBeTruthy();
  return id as string;
}

async function removeClient(request: import('@playwright/test').APIRequestContext, id: string) {
  await gqlPost(request, `mutation { removeClient(_id: "${id}") { isDeleted } }`, tokenFor('ADMIN_MANAGER'));
}

test('A6.1 column search returns the matching client', async ({ page, request }) => {
  const first = `QASRCH${Date.now()}`;
  const id = await seedClient(request, first);
  try {
    await page.goto(LIST_URL);
    const search = page.waitForResponse(
      (r) => r.url().includes('/graphql') && (r.request().postData() ?? '').includes('searchClient'),
    );
    await firstFilter(page).fill(first);
    await search;

    const rows = page.locator('tr.sav-row', { hasText: first });
    await expect(rows).toHaveCount(1);
    const cell = (await rows.first().locator('td.sav-td').first().innerText()).trim();
    expect(cell, 'first-name cell matches the search term').toBe(first);
  } finally {
    await removeClient(request, id);
  }
});

test('A6.2 special character in a search filter silently breaks the query (confirms S10)', async ({ page }) => {
  const errorsLogged: string[] = [];
  page.on('pageerror', (e) => errorsLogged.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errorsLogged.push(`console: ${m.text()}`);
  });
  let searchReqSent = false;
  page.on('request', (r) => {
    if (r.url().includes('/graphql') && (r.postData() ?? '').includes('searchClient')) searchReqSent = true;
  });

  await page.goto(LIST_URL);
  // The per-column filter row renders even when the list is empty.
  await expect(firstFilter(page)).toBeVisible();
  await firstFilter(page).fill('x"y'); // unescaped quote → gql tag throws while building searchClient

  await expect
    .poll(() => errorsLogged.length, { timeout: 5000, message: 'expected a client-side gql error' })
    .toBeGreaterThan(0);
  expect(searchReqSent, 'no searchClient request is sent (query construction threw)').toBeFalsy();

  await test.info().attach('A6.2-search-errors.txt', {
    body: errorsLogged.join('\n') || '(none)',
    contentType: 'text/plain',
  });
});

test('A6.3 applying then clearing a search re-issues the list query', async ({ page }) => {
  await page.goto(LIST_URL);
  await expect(firstFilter(page)).toBeVisible();

  const search = page.waitForResponse(
    (r) => r.url().includes('/graphql') && (r.request().postData() ?? '').includes('searchClient'),
  );
  await firstFilter(page).fill('zzzzz_unlikely');
  await search;

  // Clearing the filter reloads the full list via findAllClient.
  const reload = page.waitForResponse(
    (r) => r.url().includes('/graphql') && (r.request().postData() ?? '').includes('findAllClient'),
  );
  await firstFilter(page).fill('');
  await reload;
});
