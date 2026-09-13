import { test, expect, Page } from '@playwright/test';
import { authFile } from '../utils/auth';

/**
 * Guard de routes par rôle — chaque profil est borné à son propre menu.
 *
 * Vérifie le comportement RÉEL au clavier : taper l'URL d'un écran qui ne vous
 * concerne pas doit renvoyer sur votre page d'accueil, sans boucle.
 *
 * Ce guard est un garde-fou d'ERGONOMIE (le rôle vient de `localStorage`), pas
 * une mesure de sécurité : l'autorisation réelle appartient au serveur.
 */

const R = {
  DASHBOARD: '/',
  PROFILES: '/profiles/profile/profile-list',
  CLIENTS: '/clients/client/client-list',
  TICKETS: '/tickets/ticket/ticket-list',
  ARCHIVES: '/archives',
  COORD: '/tickets/ticket/coordinator-di-list',
  MAGASIN: '/tickets/ticket/magasin-di-list',
  TECH: '/tickets/ticket/tech-di-list',
  REUNIONS: '/tickets/reunions',
};

/** Va sur `url` et rend l'URL réellement atteinte (après redirection). */
async function land(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  return new URL(page.url()).pathname.replace(/\/$/, '') || '/';
}

/** Chaque rôle : ce qu'il DOIT atteindre, ce dont il DOIT être écarté, et où il retombe. */
const CASES = [
  { key: 'MAGASIN', home: R.MAGASIN,
    allowed: [R.MAGASIN],
    denied: [R.COORD, R.PROFILES, R.TICKETS, R.DASHBOARD, R.CLIENTS, R.ARCHIVES, R.TECH] },
  { key: 'COORDINATOR', home: R.COORD,
    allowed: [R.COORD, R.REUNIONS],
    denied: [R.MAGASIN, R.PROFILES, R.TICKETS, R.DASHBOARD, R.TECH] },
  { key: 'TECH', home: R.TECH,
    allowed: [R.TECH],
    denied: [R.PROFILES, R.TICKETS, R.DASHBOARD, R.COORD, R.MAGASIN, R.REUNIONS] },
  { key: 'ADMIN_MANAGER', home: R.TICKETS,
    allowed: [R.DASHBOARD, R.PROFILES, R.CLIENTS, R.TICKETS, R.ARCHIVES, R.COORD, R.MAGASIN, R.TECH, R.REUNIONS],
    denied: [] },
] as const;

for (const c of CASES) {
  test.describe(`${c.key}`, () => {
    test.use({ storageState: authFile(c.key as any) });

    test('atteint les écrans de son menu', async ({ page }) => {
      for (const url of c.allowed) {
        expect(await land(page, url), `${c.key} devrait atteindre ${url}`).toBe(
          url.replace(/\/$/, '') || '/',
        );
      }
    });

    test('est écarté des écrans des autres profils', async ({ page }) => {
      for (const url of c.denied) {
        const landed = await land(page, url);
        expect(landed, `${c.key} ne doit PAS rester sur ${url}`).not.toBe(url);
        expect(landed, `${c.key} devrait retomber sur ${c.home}`).toBe(c.home);
      }
    });
  });
}

test.describe('cas limites', () => {
  test.use({ storageState: authFile('MAGASIN') });

  test('le deep-link des notifications survit à la query string', async ({ page }) => {
    // `?di=…&action=detail` ne doit pas faire échouer la correspondance d'URL.
    await page.goto(`${R.MAGASIN}?di=DI_x&action=detail`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(new RegExp(R.MAGASIN.replace(/\//g, '\\/')));
  });

  test('rôle absent → connexion, SANS boucle de redirection', async ({ page }) => {
    await page.goto(R.MAGASIN, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('role'));
    await page.goto(R.MAGASIN, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15_000 });
  });

  test('vestiges du gabarit refusés à tous', async ({ page }) => {
    for (const url of ['/uikit/table', '/pages/crud', '/documentation']) {
      expect(await land(page, url), `${url} ne doit être atteignable par personne`).toBe(R.MAGASIN);
    }
  });
});
