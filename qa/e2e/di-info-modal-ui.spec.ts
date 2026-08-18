import { test, expect, Page } from '@playwright/test';
import { authFile } from '../utils/auth';

/**
 * UI end-to-end du modal « Dossier d'intervention » refondu (di-info-modal),
 * ouvert via le DEEP-LINK `/tickets/ticket/ticket-list?di=<_id>&action=detail`
 * → `DiDetailService.openById` (le chemin qui, avant, n'avait PAS le dossier par
 * cycle ; désormais unifié sur `di.logs`). On vérifie la coque scroll, le
 * sélecteur de cycle, la timeline (5 + dépliage), les finances (écart sain) et la
 * DI minimale. LECTURE SEULE — aucune mutation.
 */
test.use({ storageState: authFile('ADMIN_MANAGER') });

const TICKET_LIST = '/tickets/ticket/ticket-list';
const DI = {
  noRetour: 'DI_fluK', // DI23 — 0 retour, 3 transitions
  oneRetour: 'DI_px96', // DI20 — 1 retour
  twoRetours: 'DI_RCm5', // DI19 — 2 retours
  richSteps: 'DI_Yzki', // T1420 — 13 transitions, 0 retour
  minimal: 'DI_A0tj', // T1385 — DI minimale
};

async function openModal(page: Page, diId: string) {
  await page.goto(`${TICKET_LIST}?di=${diId}&action=detail`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page, 'redirigé vers /auth/login → token expiré ?').not.toHaveURL(
    /\/auth\/login/,
  );
  const modal = page.locator('.di-info-modal');
  await expect(modal).toBeVisible({ timeout: 25_000 });
  // di$ chargé → la table Finances rend ses 3 lignes (dont Total).
  await expect(modal.locator('.di-fin-row--total')).toBeVisible({
    timeout: 20_000,
  });
  return modal;
}

test('coque : en-tête + sélecteur + pied fixes, corps défilant (1 scrollbar), ~85vh', async ({
  page,
}) => {
  const modal = await openModal(page, DI.richSteps);
  await expect(modal.locator('.di-fixed-top')).toBeVisible();
  await expect(modal.locator('.di-body.di-scroll')).toBeVisible();
  await expect(modal.locator('.di-foot')).toBeVisible();

  // Le corps est la SEULE zone défilante.
  const overflowY = await modal
    .locator('.di-body')
    .evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflowY).toBe('auto');

  // Carte bornée à ~85vh.
  const cardH = await modal.evaluate((el) => (el as HTMLElement).offsetHeight);
  const vh = await page.evaluate(() => window.innerHeight);
  expect(cardH).toBeLessThanOrEqual(Math.round(vh * 0.86) + 4);

  // Bande de faits (4).
  await expect(modal.locator('.di-facts .di-fact')).toHaveCount(4);
});

test('finances : ligne Total + écart SAIN (aucun pourcentage aberrant)', async ({
  page,
}) => {
  const modal = await openModal(page, DI.richSteps);
  await expect(modal.locator('.di-fin-row')).toHaveCount(3); // Diagnostic, Réparation, Total
  await expect(modal.locator('.di-fin-row--total')).toContainText('Total');
  // Plus jamais de +20 762 % : aucun pourcentage à 4 chiffres ou plus.
  const fin = await modal.locator('.di-fin-table').innerText();
  expect(fin).not.toMatch(/[+-]?\d{4,}(?:[.,]\d+)?\s*%/);
});

test('écart entre statuts : 5 étapes puis « Tout afficher » (T1420, 13 transitions)', async ({
  page,
}) => {
  const modal = await openModal(page, DI.richSteps);
  const steps = modal.locator('.di-step');
  const preview = await steps.count();
  expect(preview).toBeGreaterThan(0);
  expect(preview).toBeLessThanOrEqual(5);

  const more = modal.locator('.di-steps__more');
  if (await more.count()) {
    await expect(more).toContainText('Tout afficher');
    await more.click();
    const expanded = await steps.count();
    expect(expanded).toBeGreaterThan(preview);
    await expect(more).toContainText('Réduire');
  }
});

test('sélecteur de cycle ABSENT si la DI n’a aucun retour', async ({ page }) => {
  const modal = await openModal(page, DI.noRetour);
  await expect(modal.locator('.di-cycles')).toHaveCount(0);
});

test('sélecteur de cycle présent + changement de cycle (DI19, 2 retours)', async ({
  page,
}) => {
  const modal = await openModal(page, DI.twoRetours);
  await expect(modal.locator('.di-cycles')).toBeVisible();
  const pills = modal.locator('.di-cycle-pill');
  await expect(pills).toHaveCount(3); // Flux original + Retour 1 + Retour 2
  // Ouvre sur le cycle courant (le plus récent = Retour 2) → dernière pastille active.
  await expect(pills.nth(2)).toHaveClass(/di-cycle-pill--active/);
  // Sélectionne « Flux original » → devient active.
  await pills.nth(0).click();
  await expect(pills.nth(0)).toHaveClass(/di-cycle-pill--active/);
  await expect(pills.nth(2)).not.toHaveClass(/di-cycle-pill--active/);
});

test('DI minimale : aucune section fantôme, aucun « undefined »', async ({
  page,
}) => {
  const modal = await openModal(page, DI.minimal);
  const txt = (await modal.innerText()).toLowerCase();
  expect(txt).not.toContain('undefined');
  await expect(modal.locator('.di-facts .di-fact')).toHaveCount(4);
  await expect(modal.locator('.di-foot')).toBeVisible();
});

test('export PDF : télécharge un vrai PDF (parcours + finances)', async ({
  page,
}) => {
  const modal = await openModal(page, DI.richSteps);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    modal
      .locator('.di-foot')
      .getByRole('button', { name: /Exporter PDF/ })
      .click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^DI_.*\.pdf$/);
});
