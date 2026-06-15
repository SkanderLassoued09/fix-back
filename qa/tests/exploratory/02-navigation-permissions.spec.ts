import { test, expect, authFile } from '../../fixtures/auth';
import { ROLE_ACCOUNTS } from '../../utils/roles';
import { tokenFor, authFile as af } from '../../utils/auth';
import { gqlPost } from '../../utils/graphql';

/**
 * Area 2 — Navigation, menu & the documented permission gap.
 *
 * Confirms (not "discovers"): role-gating is UI-only (known-issues S3/S4) — the
 * router has no role guard and the backend does not gate reads by role — while
 * verifying the few JwtAuthGuard-protected mutations DO reject anonymous calls.
 */

// Expected sidebar links per role (labels are matched case-insensitively as
// substrings; the leading menu icon is ignored). Grounded in app.menu.component.ts.
const MENU: Record<string, { links: string[]; absent: string[] }> = {
  ADMIN_MANAGER: {
    links: ['STAFF', 'Client', 'Company', 'Tous les DI', 'Coordinator-list', 'Magasin list', 'Tech list'],
    absent: [],
  },
  ADMIN_TECH: {
    links: ['STAFF', 'Client', 'Company', 'Tous les DI', 'Coordinator-list', 'Magasin list', 'Tech list'],
    absent: [],
  },
  MANAGER: {
    links: ['STAFF', 'Client', 'Company', 'Tous les DI'],
    absent: ['Coordinator-list', 'Magasin list', 'Tech list'],
  },
  COORDINATOR: {
    links: ['Coordinator-list'],
    absent: ['Tous les DI', 'Magasin list', 'Tech list', 'STAFF'],
  },
  TECH: {
    links: ['Tech list'],
    absent: ['Tous les DI', 'Coordinator-list', 'Magasin list', 'STAFF'],
  },
  MAGASIN: {
    links: ['Magasin list'],
    absent: ['Tous les DI', 'Coordinator-list', 'Tech list', 'STAFF'],
  },
};

// ── Per-role menu correctness ───────────────────────────────────────────────
for (const account of ROLE_ACCOUNTS) {
  test.describe(`A2 menu — ${account.key}`, () => {
    test.use({ storageState: af(account.key) });

    test(`shows only the menu links its role should see`, async ({ page }) => {
      await page.goto(account.primaryTicketRoute);
      const expected = MENU[account.key];

      for (const label of expected.links) {
        await expect(page.getByRole('link', { name: label }), `link "${label}" present`).toBeVisible();
      }
      for (const label of expected.absent) {
        await expect(
          page.getByRole('link', { name: label }),
          `link "${label}" must NOT be shown to ${account.key}`,
        ).toHaveCount(0);
      }
    });
  });
}

// ── Dashboard route reachable for roles whose menu hides/omits it ────────────
test.describe('A2 dashboard-route mismatch', () => {
  for (const key of ['TECH', 'COORDINATOR', 'MAGASIN']) {
    test.describe(key, () => {
      test.use({ storageState: af(key) });

      test(`${key} can still load the dashboard route '/' (menu item disabled/absent)`, async ({ page, gql }) => {
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));

        await page.goto('/');
        // No role guard → the route loads instead of redirecting.
        await expect(page).not.toHaveURL(/\/auth\/login/);
        await expect(page).toHaveURL(/localhost:4200\/?$/);

        // Record what the dashboard did for a role not meant to have it.
        const dashOps = gql.records.filter((r) => (r.rootField ?? '').toLowerCase().startsWith('dashboard'));
        await test.info().attach(`${key}-dashboard-route.json`, {
          body: JSON.stringify(
            {
              dashboardOpsFired: dashOps.map((o) => ({ field: o.rootField, hasErrors: o.hasErrors })),
              pageErrors,
            },
            null,
            2,
          ),
          contentType: 'application/json',
        });

        // A non-dashboard role landing here should at least not crash the page.
        expect.soft(pageErrors, `no uncaught page error on '/' for ${key}`).toEqual([]);
      });
    });
  }
});

// ── UI deep-link bypass (no role-based route guard) — confirms S3/S4 ─────────
test.describe('A2 deep-link bypass (as TECH)', () => {
  test.use({ storageState: authFile('TECH') });

  test('TECH can deep-link into admin/manager-only routes (no role route guard)', async ({ page }) => {
    await page.goto('/profiles/profile/profile-list');
    await expect(page, 'staff page loads for TECH — not redirected').toHaveURL(/\/profiles\/profile\/profile-list/);

    await page.goto('/tickets/ticket/ticket-list');
    await expect(page, 'all-DI manager view loads for TECH').toHaveURL(/\/tickets\/ticket\/ticket-list/);
  });
});

// ── Backend permission gap (read-only / non-destructive) ─────────────────────
test.describe('A2 backend permission gap (GraphQL API)', () => {
  test('a TECH token can read the staff list the UI restricts to admins/managers (confirms S3/S4)', async ({ request }) => {
    const res = await gqlPost(
      request,
      `{ getAllProfiles(paginationConfig: { rows: 5, first: 0 }) { totalProfileCount } }`,
      tokenFor('TECH'),
    );
    expect(res.errors, 'backend returned no errors to a TECH-token staff query').toBeNull();
    expect(
      res.data?.getAllProfiles?.totalProfileCount,
      'staff list data is returned to a low-privilege role (no server-side role gate)',
    ).toBeGreaterThanOrEqual(0);
  });

  test('FINDING: JwtAuthGuard does NOT block anonymous calls — resolver runs without auth', async ({ request }) => {
    // confirmDiComponents is decorated @UseGuards(JwtAuthGuard). With NO token the
    // guard SHOULD reject. Instead the resolver executes and returns a domain 404
    // ("DI ... not found") — proving the guard never enforces authentication.
    // Root cause: JwtAuthGuard.handleRequest returns undefined (no throw) when there
    // is no user, so canActivate resolves truthy. (See jwt-auth-guard.ts.)
    const res = await gqlPost(
      request,
      `mutation { confirmDiComponents(diId: "000000000000000000000000") { _id } }`,
    );

    expect(res.errors, 'an error is returned').not.toBeNull();
    // The error is a DOMAIN not-found, NOT an authorization rejection → the
    // resolver/service actually executed for an unauthenticated caller.
    expect(res.errorText, 'must NOT be an auth error (guard let it through)').not.toContain('unauthor');
    expect(res.errorText, 'resolver executed → domain not-found error').toContain('not found');

    await test.info().attach('A2-authguard-bypass.json', {
      body: JSON.stringify(res.errors, null, 2),
      contentType: 'application/json',
    });
  });
});
