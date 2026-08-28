import { test, expect } from '@playwright/test';
import { authFile } from '../utils/auth';

/** F1 fix — le champ « Prix du diagnostic à facturer ? » est PRÉ-REMPLI avec
 *  l'estimation saisie à la création. T1444 (PRICING_DIAG) porte
 *  diagnosticEstimate=150 en base ; le deep-link ?action=pricing ouvre le modal
 *  de tarification. Le correctif ajoute le champ aux queries LISTE (searchDi/
 *  getAllDi) → il arrive enfin dans rowData. */
test.use({ storageState: authFile('ADMIN_MANAGER') });

test('tarification : prix pré-rempli depuis l’estimation + estimation d’origine visible (T1444=150)', async ({
  page,
}) => {
  await page.goto('/tickets/ticket/ticket-list?di=DI_13yR&action=pricing', {
    waitUntil: 'domcontentloaded',
  });
  const input = page.locator('#pricing-init-input');
  await expect(input, "le modal de tarification ne s'est pas ouvert").toBeVisible(
    { timeout: 30_000 },
  );
  // Pré-rempli avec l'estimation de création (150), pas vide.
  await expect(input).toHaveValue(/150/, { timeout: 15_000 });
  // Estimation d'origine rappelée à côté du champ.
  await expect(page.locator('.pricing-estimate-orig')).toContainText('150');
});
