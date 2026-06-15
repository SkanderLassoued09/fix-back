import { test, expect, authFile } from '../../fixtures/auth';
import { loginViaUI } from '../../utils/auth';
import { accountByKey } from '../../utils/roles';

/**
 * Area 1 — Auth & session.
 * Acts like a real user: valid + wrong + empty + malformed input, guard
 * behavior, logout, persistence, token tampering. GraphQL-aware throughout
 * (judges by response errors/data, not the HTTP 200).
 */

const MANAGER = accountByKey('MANAGER');

test.describe('Area 1 — Auth (unauthenticated context)', () => {
  test('A1.1 valid login fires exactly one login op, no errors, stores token', async ({ page, gql }) => {
    const r = await loginViaUI(page, MANAGER);

    expect(r.ok, 'token stored').toBeTruthy();
    expect(r.errors, 'no GraphQL errors').toBeNull();
    await expect(page).not.toHaveURL(/\/auth\/login/);

    expect(gql.byField('login').length, 'exactly one login op per click').toBe(1);
    expect(gql.duplicates(), 'no duplicate ops').toHaveLength(0);
  });

  test('A1.2 wrong password is rejected (GraphQL errors, no token, stays on login)', async ({ page, gql }) => {
    const r = await loginViaUI(page, { ...MANAGER, password: 'definitely-wrong-zzz' });

    expect(r.ok, 'no token on bad password').toBeFalsy();
    await expect(page).toHaveURL(/\/auth\/login/);

    const login = gql.byField('login').at(-1);
    expect(login?.hasErrors, 'login returned a GraphQL errors[] despite HTTP 200').toBeTruthy();

    // Real users should see feedback; capture whether the error toast appears.
    await expect
      .soft(page.locator('.p-toast-message'), 'error toast shown to user')
      .toBeVisible({ timeout: 4000 });
  });

  test('A1.3 unknown username is rejected', async ({ page, gql }) => {
    const r = await loginViaUI(page, { ...MANAGER, username: 'no_such_user_42' });

    expect(r.ok).toBeFalsy();
    await expect(page).toHaveURL(/\/auth\/login/);
    expect(gql.byField('login').at(-1)?.hasErrors, 'GraphQL errors[] present').toBeTruthy();
  });

  test('A1.4 empty credentials: no client-side validation; form submits literal "null"', async ({ page }) => {
    await page.goto('/auth/login');
    // Inspect the awaited Response directly (avoids any recorder timing race).
    const loginResp = page.waitForResponse(
      (r) =>
        r.url().includes('/graphql') &&
        r.request().method() === 'POST' &&
        (r.request().postData() ?? '').includes('login('),
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: 'Sign In' }).click(); // both fields untouched
    const resp = await loginResp;

    const sentQuery = JSON.parse(resp.request().postData() || '{}').query as string;
    const body = await resp.json();
    // FormControl default value is null → `${null}` interpolates the string "null".
    expect(sentQuery, 'empty field serialized as the literal "null" (no required validation)').toContain(
      'username: "null"',
    );
    expect(
      Array.isArray(body.errors) && body.errors.length > 0,
      'backend rejects the "null" user (errors[] despite HTTP 200)',
    ).toBeTruthy();
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test('A1.5 special char in username silently breaks login client-side (confirms known-issues S10)', async ({ page }) => {
    // The login query is hand-built by interpolating the username into a gql`` string.
    // An unescaped " makes the gql tag throw while BUILDING the document — so NO request
    // is sent and the user gets no feedback (the button appears to do nothing).
    const errorsLogged: string[] = [];
    page.on('pageerror', (e) => errorsLogged.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errorsLogged.push(`console: ${m.text()}`);
    });
    let loginRequestSent = false;
    page.on('request', (r) => {
      if (r.url().includes('/graphql') && (r.postData() ?? '').includes('login(')) {
        loginRequestSent = true;
      }
    });

    await page.goto('/auth/login');
    await page.locator('#username').fill('evil" injected');
    await page.locator('input[type="password"]').fill('123456');
    await page.getByRole('button', { name: 'Sign In' }).click();

    // A client-side error is logged (query construction threw); poll, no fixed sleep.
    await expect
      .poll(() => errorsLogged.length, {
        timeout: 5000,
        message: 'expected a client-side JS error from the broken gql query',
      })
      .toBeGreaterThan(0);

    expect(loginRequestSent, 'no GraphQL login request is ever sent').toBeFalsy();
    await expect(page, 'user stays on login with no feedback').toHaveURL(/\/auth\/login/);
    expect(await page.evaluate(() => localStorage.getItem('token')), 'no token').toBeFalsy();

    await test.info().attach('A1.5-client-errors.txt', {
      body: errorsLogged.join('\n') || '(none captured)',
      contentType: 'text/plain',
    });
  });

  test('A1.6 route guard redirects an unauthenticated user to /auth/login', async ({ page }) => {
    await page.goto('/tickets/ticket/ticket-list');
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test('A1.7 token tampering: client guard checks presence only (confirms known-issues S9)', async ({ page, context }) => {
    // No real login — plant a garbage token before any app script runs.
    await context.addInitScript(() => localStorage.setItem('token', 'garbage.tampered.token'));
    await page.goto('/tickets/ticket/ticket-list');

    // authGuard only checks token PRESENCE, so a bogus token still grants UI access.
    await expect(page, 'bogus token still bypasses the client route guard').not.toHaveURL(/\/auth\/login/);
  });
});

test.describe('Area 1 — Auth (authenticated as MANAGER)', () => {
  test.use({ storageState: authFile('MANAGER') });

  test('A1.8 session persists across a full page reload', async ({ page }) => {
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/auth\/login/);
    await page.reload();
    await expect(page).not.toHaveURL(/\/auth\/login/);
    expect(await page.evaluate(() => localStorage.getItem('token')), 'token survives reload').toBeTruthy();
  });

  test('A1.9 logout clears the session and blocks protected routes', async ({ page }) => {
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/auth\/login/);

    // Desktop topbar: the logout trigger is the icon-only button inside
    // .layout-topbar-menu (its "Profile" <span> is display:none, so it has no
    // accessible name; the .layout-topbar-menu-button ellipsis is mobile-only).
    await page.locator('.layout-topbar-menu button').click();
    await page.getByRole('button', { name: 'Déconnexion' }).click();

    await expect(page).toHaveURL(/\/auth\/login/);
    expect(await page.evaluate(() => localStorage.getItem('token')), 'token cleared on logout').toBeFalsy();

    // Session is truly gone: a protected route now redirects back to login.
    await page.goto('/tickets/ticket/ticket-list');
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
