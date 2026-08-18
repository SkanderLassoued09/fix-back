import { test, expect } from '@playwright/test';
import { authFile } from '../utils/auth';

/** F1 (c) — estimation HORS bornes (100 < 150) : pré-remplie telle quelle,
 *  avertissement NON bloquant, soumission possible. T1444 est réglée à 100 par
 *  l'orchestrateur avant ce test. */
test.use({ storageState: authFile('ADMIN_MANAGER') });

test('tarification : estimation hors bornes (100) → pré-remplie + avertissement, non bloquant', async ({
  page,
}) => {
  await page.goto('/tickets/ticket/ticket-list?di=DI_13yR&action=pricing', {
    waitUntil: 'domcontentloaded',
  });
  const input = page.locator('#pricing-init-input');
  await expect(input).toBeVisible({ timeout: 30_000 });
  // Pré-rempli à 100 (pas ramené à 150).
  await expect(input).toHaveValue(/100/, { timeout: 15_000 });
  // Avertissement non bloquant visible.
  await expect(page.locator('.pricing-warn')).toBeVisible();
  await expect(page.locator('.pricing-warn')).toContainText('hors des bornes');
  // Renseigner l'estimation réparation (gate séparé et légitime) — si présente.
  const rep = page.locator('#pricing-repair-estimate');
  if (await rep.count()) {
    await rep.fill('200');
    await rep.blur();
  }
  // Le prix diagnostic HORS bornes (100) ne bloque PAS la soumission (souple).
  const validate = page.getByRole('button', { name: /Valider le prix/ });
  await expect(validate).toBeEnabled({ timeout: 10_000 });
});
