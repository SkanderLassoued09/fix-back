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
  // Libellés VIVANTS du menu (français). L'ancienne table attendait encore les
  // libellés anglais ('STAFF', 'Magasin list'…) qui ne subsistent que dans le
  // bloc commenté mort de `app.menu.component.ts` — d'où 6 échecs sans rapport
  // avec le guard.
  //
  // « Archives DI » et « Réunions » sont désormais MASQUÉS pour TOUS les rôles :
  // ils sont donc listés en `absent` partout. Attention à la nuance — masquer
  // n'est pas interdire : les routes restent ouvertes et les listes blanches de
  // `role-routes.ts` sont inchangées (un rappel Discord poste un lien vers
  // `/tickets/reunions`). C'est `route-role-guard.spec.ts` qui couvre l'ACCÈS ;
  // ici on ne vérifie que la VISIBILITÉ dans le menu.
  ADMIN_MANAGER: {
    links: ['Tableau de bord', 'Personnel', 'Clients', 'Sociétés', 'Toutes les DI',
            'Coordination', 'Magasin', 'Atelier technique'],
    absent: ['Archives DI', 'Réunions'],
  },
  ADMIN_TECH: {
    links: ['Tableau de bord', 'Personnel', 'Clients', 'Sociétés', 'Toutes les DI',
            'Coordination', 'Magasin', 'Atelier technique'],
    absent: ['Archives DI', 'Réunions'],
  },
  MANAGER: {
    links: ['Personnel', 'Clients', 'Sociétés', 'Toutes les DI'],
    absent: ['Tableau de bord', 'Coordination', 'Magasin', 'Atelier technique',
             'Archives DI', 'Réunions'],
  },
  COORDINATOR: {
    links: ['Coordination'],
    absent: ['Tableau de bord', 'Toutes les DI', 'Magasin', 'Atelier technique', 'Personnel',
             'Archives DI', 'Réunions'],
  },
  TECH: {
    links: ['Atelier technique'],
    absent: ['Tableau de bord', 'Toutes les DI', 'Coordination', 'Magasin', 'Personnel',
             'Réunions', 'Archives DI'],
  },
  MAGASIN: {
    links: ['Magasin'],
    absent: ['Tableau de bord', 'Toutes les DI', 'Coordination', 'Atelier technique', 'Personnel',
             'Réunions', 'Archives DI'],
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

// ── Dashboard route now BLOCKED for roles whose menu hides/omits it ─────────
test.describe('A2 dashboard-route mismatch', () => {
  for (const key of ['TECH', 'COORDINATOR', 'MAGASIN']) {
    test.describe(key, () => {
      test.use({ storageState: af(key) });

      test(`${key} is redirected away from the dashboard route '/'`, async ({ page, gql }) => {
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));

        await page.goto('/');
        // The role route guard now sends the user to their own landing page.
        // (This test used to assert the OPPOSITE — it documented the missing
        // guard. Inverted when the guard landed, same as the S12 inversion.)
        await expect(page).not.toHaveURL(/\/auth\/login/);
        await expect(page, `${key} must not sit on the dashboard`).not.toHaveURL(
          /localhost:4200\/?$/,
        );

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

        // The redirect itself must not crash the page.
        expect.soft(pageErrors, `no uncaught page error on '/' for ${key}`).toEqual([]);
      });
    });
  }
});

// ── UI deep-link bypass — CLOSED by the role route guard ────────────────────
test.describe('A2 deep-link bypass (as TECH)', () => {
  test.use({ storageState: authFile('TECH') });

  test('TECH is redirected away from admin/manager-only routes', async ({ page }) => {
    // Previously this test asserted the pages LOADED for a TECH — it documented
    // the absence of any role route guard (S3/S4). The guard now redirects to
    // the role's own landing page, so both assertions are inverted.
    const TECH_HOME = '/tickets/ticket/tech-di-list';

    await page.goto('/profiles/profile/profile-list');
    await expect(page, 'staff page must NOT load for TECH').toHaveURL(
      new RegExp(TECH_HOME.replace(/\//g, '\\/')),
    );

    await page.goto('/tickets/ticket/ticket-list');
    await expect(page, 'all-DI manager view must NOT load for TECH').toHaveURL(
      new RegExp(TECH_HOME.replace(/\//g, '\\/')),
    );
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

  test('S12 CORRIGÉ : JwtAuthGuard bloque bien les appels anonymes', async ({ request }) => {
    // Ce test asserait AUTREFOIS le bug : `confirmDiComponents` est décorée
    // @UseGuards(JwtAuthGuard), et sans jeton le resolver s'exécutait quand même
    // (erreur de domaine « not found » au lieu d'un refus d'authentification),
    // parce que `handleRequest` renvoyait `undefined` sans lever.
    // La garde lève désormais UNAUTHENTICATED : les assertions sont inversées.
    const res = await gqlPost(
      request,
      `mutation { confirmDiComponents(diId: "000000000000000000000000") { _id } }`,
    );

    expect(res.errors, 'un appel anonyme doit être refusé').not.toBeNull();
    // Refus d'AUTHENTIFICATION — le resolver ne doit jamais s'exécuter.
    expect(
      res.errorText,
      "doit être un refus d'authentification",
    ).toMatch(/authentification requise|unauthenticated|unauthor/i);
    // Et surtout PAS une erreur de domaine, qui prouverait que le resolver a tourné.
    expect(
      res.errorText,
      'le resolver ne doit PAS avoir été atteint',
    ).not.toContain('not found');

    await test.info().attach('A2-authguard-enforced.json', {
      body: JSON.stringify(res.errors, null, 2),
      contentType: 'application/json',
    });
  });
});
