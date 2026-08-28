import { test, expect } from '@playwright/test';
import { authFile } from '../utils/auth';

/** feat/prix-diagnostic-tarification — DI PAYANTE SANS estimation de création :
 *  le champ prix est VIDE (pas de pré-remplissage), et le garde-fou bornes
 *  150–500 REVIENT en SAISIE MANUELLE (avertissement non bloquant si hors
 *  bornes). Toujours ni boutons de majoration ni indicateur de marge (retirés
 *  définitivement). T1444 (DI_13yR) est réglée à estimate=null par
 *  l'orchestrateur avant ce test. */
test.use({ storageState: authFile('ADMIN_MANAGER') });

test('tarification : payante SANS estimation → champ vide + avertissement bornes en saisie manuelle', async ({
  page,
}) => {
  await page.goto('/tickets/ticket/ticket-list?di=DI_13yR&action=pricing', {
    waitUntil: 'domcontentloaded',
  });
  const input = page.locator('#pricing-init-input');
  await expect(input).toBeVisible({ timeout: 30_000 });

  // Aucune estimation → pas de note « Estimation à la création ».
  await expect(page.locator('.pricing-estimate-orig')).toHaveCount(0);

  // Saisie MANUELLE hors bornes → le garde-fou 150–500 REVIENT.
  await input.click();
  await input.fill('600');
  await input.blur();
  await expect(page.locator('.pricing-warn')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.pricing-warn')).toContainText('hors des bornes');

  // Aide au calcul TOUJOURS retirée (chips/marge), même en saisie manuelle.
  await expect(page.locator('.pricing-chips')).toHaveCount(0);
  await expect(page.locator('.pricing-ecart')).toHaveCount(0);
});
