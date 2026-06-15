import { test, expect } from '../../fixtures/auth';
import { loginViaUI } from '../../utils/auth';
import { ROLE_ACCOUNTS, accountByKey } from '../../utils/roles';

/**
 * Regression — authentication.
 * Stable, deterministic: each seeded role logs in through the real UI and lands
 * authenticated with the documented role; a wrong password is rejected.
 */

for (const account of ROLE_ACCOUNTS) {
  test(`login succeeds for ${account.key} (${account.username})`, async ({ page }) => {
    const r = await loginViaUI(page, account);
    expect(r.errors, 'no GraphQL errors on login').toBeNull();
    expect(r.ok, 'token persisted').toBeTruthy();
    await expect(page).not.toHaveURL(/\/auth\/login/);
    expect(r.role, 'stored role matches the documented value').toBe(account.expectedRole);
  });
}

test('login is rejected with a wrong password', async ({ page }) => {
  const r = await loginViaUI(page, { ...accountByKey('MANAGER'), password: 'wrong-password-zzz' });
  expect(r.ok, 'no token on bad password').toBeFalsy();
  await expect(page).toHaveURL(/\/auth\/login/);
});
