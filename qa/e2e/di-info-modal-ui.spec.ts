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
  // Le dossier s'ouvre sur l'onglet « Dossier » : la bande de faits est le
  // premier rendu qui prouve que `di$` est arrivé. (Les Finances vivent
  // désormais dans leur PROPRE onglet — les attendre ici bloquait.)
  await expect(modal.locator('.di-facts .di-fact').first()).toBeVisible({
    timeout: 20_000,
  });
  return modal;
}

/** Bascule sur un onglet du dossier et attend qu'il devienne actif. */
async function openTab(modal: any, label: string) {
  const tab = modal.locator('.di-tab', { hasText: label });
  await tab.click();
  await expect(tab).toHaveClass(/di-tab--active/);
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
  // 5 faits permanents (client, emplacement, n° série, retours, catégorie)
  // + jusqu'à 2 conditionnels (date de réception, ancienneté dans le statut).
  const factCount = await modal.locator('.di-facts .di-fact').count();
  expect(factCount).toBeGreaterThanOrEqual(5);
  expect(factCount).toBeLessThanOrEqual(7);
});

test('finances : ligne Total + écart SAIN (aucun pourcentage aberrant)', async ({
  page,
}) => {
  const modal = await openModal(page, DI.richSteps);
  await openTab(modal, 'Finances');
  await expect(modal.locator('.di-fin-row')).toHaveCount(3); // Diagnostic, Réparation, Total
  await expect(modal.locator('.di-fin-row--total')).toContainText('Total');
  // Plus jamais de +20 762 % : aucun pourcentage à 4 chiffres ou plus.
  const fin = await modal.locator('.di-fin-table').innerText();
  expect(fin).not.toMatch(/[+-]?\d{4,}(?:[.,]\d+)?\s*%/);
});

test('parcours du dossier : vue simple, détail technique replié (T1420)', async ({
  page,
}) => {
  const modal = await openModal(page, DI.richSteps);
  // Le parcours vit dans « Temps & chrono ».
  await openTab(modal, 'Temps & chrono');
  const flow = modal.locator('.di-flow');
  test.skip(
    (await flow.locator('.di-empty').count()) > 0,
    'fixture sans historique dans cette base',
  );

  // Vue simple : ni frise horizontale ni tableau « Temps passé par étape » ;
  // le compteur de pauses est toujours là (« Aucune pause » sinon) ; plus de liste « Étapes ».
  await expect(flow.locator('.di-stepper__item')).toHaveCount(0);
  await expect(flow.locator('.di-phase-table')).toHaveCount(0);
  await expect(flow.locator('.di-pause-sum')).toHaveCount(1);
  await expect(flow.locator('.di-passage')).toHaveCount(0);

  // Le détail à la seconde est replié par défaut…
  await expect(flow.locator('.di-step')).toHaveCount(0);
  const toggle = flow.locator('.di-flow-detail__toggle');
  await expect(toggle).toContainText('Détail technique');
  const n = Number((await toggle.innerText()).match(/(\d+)\s+changement/)?.[1]);
  expect(n).toBeGreaterThan(0);

  // …et déplié, il liste CHAQUE changement.
  await toggle.click();
  await expect(flow.locator('.di-step')).toHaveCount(n);
  await expect(toggle).toContainText('Masquer');
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
  // 5 faits permanents (client, emplacement, n° série, retours, catégorie)
  // + jusqu'à 2 conditionnels (date de réception, ancienneté dans le statut).
  const factCount = await modal.locator('.di-facts .di-fact').count();
  expect(factCount).toBeGreaterThanOrEqual(5);
  expect(factCount).toBeLessThanOrEqual(7);
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
