import { test, expect, authFile } from '../../fixtures/auth';

/**
 * Area 3 — Reference CRUD.
 *
 * Clients is tested as the DEEP REPRESENTATIVE of the reference-data CRUD pattern
 * (create/edit/delete via dialogs + a string-interpolated GraphQL service).
 * Companies and Profiles use the identical `gql`-interpolation services
 * (company.service.ts / profile.service.ts) and dialog pattern — see backlog.
 *
 * Run as ADMIN_MANAGER (has the Client menu).
 */

test.use({ storageState: authFile('ADMIN_MANAGER') });

const LIST_URL = '/clients/client/client-list';

async function openAddDialog(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Ajouter un client' }).click();
  await expect(page.locator('#first_name')).toBeVisible();
}

/** The add-dialog submit button. Targeted by its p-button label attribute to
 *  avoid (a) the leading-space accessible-name quirk and (b) matching the
 *  "Ajouter un client" open button. */
function addSubmit(page: import('@playwright/test').Page) {
  return page.locator('p-button[label="Ajouter"] button');
}

async function fillAddForm(
  page: import('@playwright/test').Page,
  c: { first: string; last: string; region: string; address: string; email?: string; phone: string },
) {
  await page.locator('#first_name').fill(c.first);
  await page.locator('#last_name').fill(c.last);
  await page.locator('#address').fill(c.address);
  if (c.email) await page.locator('#email').fill(c.email);
  await page.locator('p-dropdown[inputid="region"]').click(); // scope past the paginator's rpp dropdown
  await page.getByRole('option', { name: c.region }).click();
  const phone = page.locator('p-inputmask input');
  await phone.click();
  await phone.pressSequentially(c.phone);
}

/** Search the Prénom column (first "Chercher..." filter) and wait for the result. */
async function searchByFirstName(page: import('@playwright/test').Page, value: string) {
  const resp = page.waitForResponse(
    (r) => r.url().includes('/graphql') && (r.request().postData() ?? '').includes('searchClient'),
  );
  await page.locator('input[placeholder="Chercher..."]').first().fill(value);
  await resp;
}

async function deleteClientByFirstName(page: import('@playwright/test').Page, first: string) {
  // Re-search each pass (handles the duplicate-submit case: 1 or 2 rows).
  for (let i = 0; i < 4; i++) {
    await searchByFirstName(page, first);
    const row = page.locator('tr.sav-row', { hasText: first });
    if ((await row.count()) === 0) return;
    const removed = page.waitForResponse(
      (r) => r.url().includes('/graphql') && (r.request().postData() ?? '').includes('removeClient'),
    );
    await row.first().locator('button.sav-icon-btn--danger').click();
    await page.locator('.p-confirm-dialog-accept').click();
    await removed.catch(() => undefined);
  }
}

test.describe('Area 3 — Reference CRUD (Clients, representative)', () => {
  test('A3.1 create a client → it persists and is searchable, then delete it', async ({ page }) => {
    const first = `QA${Date.now()}`;
    await page.goto(LIST_URL);

    await openAddDialog(page);
    await fillAddForm(page, {
      first,
      last: 'Auto',
      region: 'TUNIS',
      address: '12 Rue de Test',
      email: 'qa@example.com',
      phone: '12345678',
    });

    const created = page.waitForResponse(
      (r) => r.url().includes('/graphql') && (r.request().postData() ?? '').includes('createClient'),
    );
    await addSubmit(page).click();
    const resp = await created;

    // Inspect the awaited response directly (no recorder timing race).
    const body: any = await resp.json();
    expect(body.errors ?? null, 'createClient has no GraphQL errors').toBeNull();
    expect(body.data?.createClient?._id, 'server returned a new _id').toBeTruthy();
    await expect(page.locator('.p-toast-message-success')).toBeVisible();

    // Persisted + searchable.
    await searchByFirstName(page, first);
    await expect(page.locator('tr.sav-row', { hasText: first })).toHaveCount(1);

    // Cleanup.
    await deleteClientByFirstName(page, first);
    await expect(page.locator('tr.sav-row', { hasText: first })).toHaveCount(0);
  });

  test('A3.2 add form enforces required fields (submit disabled until complete)', async ({ page }) => {
    await page.goto(LIST_URL);
    await openAddDialog(page);

    const submit = addSubmit(page);
    await expect(submit, 'submit disabled with an empty form').toBeDisabled();

    await fillAddForm(page, {
      first: 'Val',
      last: 'Idation',
      region: 'SFAX',
      address: 'Addr',
      phone: '12345678',
    });
    await expect(submit, 'submit enabled once required fields are filled').toBeEnabled();
  });

  test('A3.3 special char in a client field silently breaks create (confirms S10)', async ({ page }) => {
    const errorsLogged: string[] = [];
    page.on('pageerror', (e) => errorsLogged.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errorsLogged.push(`console: ${m.text()}`);
    });
    let createReqSent = false;
    page.on('request', (r) => {
      if (r.url().includes('/graphql') && (r.postData() ?? '').includes('createClient')) createReqSent = true;
    });

    await page.goto(LIST_URL);
    await openAddDialog(page);
    await fillAddForm(page, {
      first: 'Bad"Name', // unescaped quote → gql tag throws while building the mutation
      last: 'Auto',
      region: 'TUNIS',
      address: 'Addr',
      phone: '12345678',
    });

    await addSubmit(page).click();

    await expect
      .poll(() => errorsLogged.length, { timeout: 5000, message: 'expected a client-side gql error' })
      .toBeGreaterThan(0);
    expect(createReqSent, 'no createClient request is sent (query construction threw)').toBeFalsy();
    await expect(page.locator('#first_name'), 'dialog stays open, no feedback').toBeVisible();

    await test.info().attach('A3.3-client-errors.txt', {
      body: errorsLogged.join('\n') || '(none)',
      contentType: 'text/plain',
    });
  });

  test('A3.4 rapid double-click submit does not create duplicate records', async ({ page }) => {
    const first = `QADUP${Date.now()}`;

    // Count createClient REQUESTS as they are dispatched (deterministic signal).
    const createReqs: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/graphql') && (r.postData() ?? '').includes('createClient')) {
        createReqs.push(r.postData() ?? '');
      }
    });

    await page.goto(LIST_URL);
    await openAddDialog(page);
    await fillAddForm(page, {
      first,
      last: 'Auto',
      region: 'TUNIS',
      address: 'Addr',
      phone: '12345678',
    });

    // Two clicks in ONE browser tick — before any response can reset/close the
    // form — to faithfully reproduce an impatient user's double-click. (Spacing
    // them via separate Playwright actions lets the fast localhost response land
    // between clicks, which would hide the race.)
    await page.evaluate(() => {
      const btn = document.querySelector('p-button[label="Ajouter"] button') as HTMLButtonElement | null;
      btn?.click();
      btn?.click();
    });

    await page.waitForLoadState('networkidle');

    // Ground truth: how many records did the double-click actually create?
    await searchByFirstName(page, first);
    const rows = await page.locator('tr.sav-row', { hasText: first }).count();

    await test.info().attach('A3.4-double-submit.txt', {
      body: `createClient requests dispatched: ${createReqs.length}; records created: ${rows}`,
      contentType: 'text/plain',
    });
    // A single user action must not create duplicate records.
    expect(rows, 'double-click created exactly one record (no duplicate)').toBe(1);

    // Cleanup whatever got created (1 or 2 rows).
    await deleteClientByFirstName(page, first);
  });
});
