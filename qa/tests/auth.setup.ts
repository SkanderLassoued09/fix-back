import { test as setup, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { ROLE_ACCOUNTS } from '../utils/roles';
import { loginViaUI, authFile } from '../utils/auth';
import { GqlRecorder } from '../utils/graphql';

/**
 * Phase-2 verification + session bootstrap.
 *
 * For each of the 6 roles this:
 *   1. logs in through the real UI,
 *   2. asserts the login GraphQL response had no `errors` (NOT just HTTP 200),
 *   3. asserts a token was persisted and we left /auth/login,
 *   4. soft-checks the stored role matches the documented value
 *      (COORDINATOR is intentionally stored as "COORDIANTOR"),
 *   5. saves the authenticated storageState to qa/.auth/<ROLE>.json for reuse.
 *
 * Run with:  npm run verify:auth   (i.e. playwright test --project=setup)
 */

const authDir = path.join(__dirname, '..', '.auth');

setup.beforeAll(() => {
  fs.mkdirSync(authDir, { recursive: true });
});

for (const account of ROLE_ACCOUNTS) {
  setup(`authenticate ${account.key} (${account.username})`, async ({ page }) => {
    const gql = new GqlRecorder(page);

    const result = await loginViaUI(page, account);

    // GraphQL-aware: a 200 with an errors[] is still a failure.
    expect(
      result.responseSeen,
      `no login GraphQL response observed for ${account.username} — is the backend up at :3000?`,
    ).toBeTruthy();
    expect(
      result.errors,
      `login returned GraphQL errors for ${account.username}: ${JSON.stringify(result.errors)}`,
    ).toBeNull();
    expect(result.ok, `no token stored for ${account.username}`).toBeTruthy();
    await expect(page, `still on login page after ${account.username} login`).not.toHaveURL(
      /\/auth\/login/,
    );

    // The login op was actually seen by the recorder (exercises the helper).
    expect(gql.byField('login').length, 'login operation observed').toBeGreaterThan(0);

    // Documented role string (soft so one mismatch doesn't mask the others).
    expect
      .soft(result.role, `stored role for ${account.username}`)
      .toBe(account.expectedRole);

    await page.context().storageState({ path: authFile(account.key) });

    await setup.info().attach(`session-${account.key}.json`, {
      body: JSON.stringify(
        {
          username: result.username,
          storedRole: result.role,
          expectedRole: account.expectedRole,
          id: result.id,
          tokenPresent: !!result.token,
          httpStatus: result.httpStatus,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });

    console.log(
      `[auth] ${account.key.padEnd(13)} username=${result.username} ` +
        `role=${result.role} token=${result.token ? 'ok' : 'MISSING'}`,
    );
  });
}
