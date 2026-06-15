import { Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { RoleAccount } from './roles';

/** Path to a role's persisted storageState (created by tests/auth.setup.ts). */
export function authFile(roleKey: string): string {
  return path.join(__dirname, '..', '.auth', `${roleKey}.json`);
}

/** Read the JWT a role obtained at login, out of its saved storageState. */
export function tokenFor(roleKey: string): string {
  const state = JSON.parse(fs.readFileSync(authFile(roleKey), 'utf-8'));
  const entry = state.origins?.[0]?.localStorage?.find((e: { name: string }) => e.name === 'token');
  if (!entry?.value) {
    throw new Error(`No token in storageState for ${roleKey} — run the setup project first.`);
  }
  return entry.value as string;
}

export interface LoginResult {
  /** True only if a token actually landed in localStorage. */
  ok: boolean;
  token: string | null;
  role: string | null;
  username: string | null;
  id: string | null;
  /** GraphQL `errors` from the login response, if any (null = clean). */
  errors: unknown[] | null;
  /** HTTP status of the login POST (expected 200 even on GraphQL failure). */
  httpStatus: number;
  /** True if a login GraphQL response was observed at all. */
  responseSeen: boolean;
}

/**
 * Logs in via the real UI (matches a real user) and reports exactly what
 * happened — token, stored role, GraphQL errors. The caller decides pass/fail.
 *
 * Selectors are grounded in the actual login template
 * (fix-front/.../auth/login/login.component.html):
 *   - username: <input id="username" pInputText>
 *   - password: PrimeNG <p-password> → single <input type="password">
 *   - submit:   <button pButton label="Sign In">
 *
 * The login document is `mutation { login(loginAuthInput: {...}) { access_token user{...} } }`
 * sent via apollo.query, so its root field is `login`.
 */
export async function loginViaUI(page: Page, account: RoleAccount): Promise<LoginResult> {
  await page.goto('/auth/login');

  await page.locator('#username').fill(account.username);
  await page.locator('input[type="password"]').fill(account.password);

  const loginResponse = page
    .waitForResponse(
      (r) => r.url().includes('/graphql') && r.request().method() === 'POST',
      { timeout: 20_000 },
    )
    .catch(() => null);

  await page.getByRole('button', { name: 'Sign In' }).click();

  let httpStatus = 0;
  let errors: unknown[] | null = null;
  let tokenFromResponse: string | null = null;
  let responseSeen = false;

  const resp = await loginResponse;
  if (resp) {
    responseSeen = true;
    httpStatus = resp.status();
    const body = await resp.json().catch(() => ({} as any));
    errors = Array.isArray(body?.errors) ? body.errors : null;
    tokenFromResponse = body?.data?.login?.access_token ?? null;
  }

  // On success the app persists localStorage then navigates to '/'. Wait for the
  // URL to leave the login page (web-first wait, no fixed sleep). Swallow the
  // timeout so a failed login still returns a structured result to assert on.
  if (tokenFromResponse) {
    await page
      .waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 15_000 })
      .catch(() => undefined);
  }

  const ls = await page.evaluate(() => ({
    token: localStorage.getItem('token'),
    role: localStorage.getItem('role'),
    username: localStorage.getItem('username'),
    id: localStorage.getItem('_id'),
  }));

  return {
    ok: !!ls.token,
    token: ls.token,
    role: ls.role,
    username: ls.username,
    id: ls.id,
    errors,
    httpStatus,
    responseSeen,
  };
}
