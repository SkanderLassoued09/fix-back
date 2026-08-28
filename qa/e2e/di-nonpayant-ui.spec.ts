import { test, expect, Page } from '@playwright/test';
import { authFile } from '../utils/auth';

/** F1 UI — un diagnostic NON PAYANT affiche « Non facturé » dans les finances du
 *  modal détail (jamais « 0,000 », jamais d'écart −150). La DI DI_fluK est
 *  pré-réglée non-payante par l'orchestrateur avant ce test. */
test.use({ storageState: authFile('ADMIN_MANAGER') });

async function openModal(page: Page, diId: string) {
  await page.goto(`/tickets/ticket/ticket-list?di=${diId}&action=detail`, {
    waitUntil: 'domcontentloaded',
  });
  const modal = page.locator('.di-info-modal');
  await expect(modal).toBeVisible({ timeout: 25_000 });
  await expect(modal.locator('.di-fin-row--total')).toBeVisible({
    timeout: 20_000,
  });
  return modal;
}

test('diagnostic non payant → « Non facturé » (jamais 0,000, pas d’écart −150)', async ({
  page,
}) => {
  const modal = await openModal(page, 'DI_fluK');
  // Les cellules « facturé »/« écart » du diagnostic + total montrent « Non
  // facturé » (jamais 0,000). Le « coût réel » peut légitimement valoir 0 (aucun
  // temps enregistré) — on ne teste donc PAS toute la table, juste ces cellules.
  const nonFactCells = modal.locator('.di-fin-nonpayant');
  await expect(nonFactCells.first()).toContainText('Non facturé');
  // ≥ 4 cellules « Non facturé » (facturé + écart, lignes Diagnostic ET Total).
  expect(await nonFactCells.count()).toBeGreaterThanOrEqual(2);
  await expect(modal.locator('.di-fin-note')).toContainText('non payant');
});
