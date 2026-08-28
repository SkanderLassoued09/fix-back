import { test, expect } from '@playwright/test';
import { authFile } from '../utils/auth';

/** feat/prix-diagnostic-tarification — quand le prix est PRÉ-REMPLI depuis
 *  l'estimation de création (DI payante + estimation), l'estimation FAIT
 *  RÉFÉRENCE : le champ est VERROUILLÉ (non modifiable) et le bloc d'aide au
 *  calcul disparaît. Même si l'estimation est hors bornes (100 < 150),
 *  l'avertissement 150–500 ne s'affiche PAS, et il n'y a NI boutons de
 *  majoration NI indicateur de marge. La soumission reste possible. T1444
 *  (DI_13yR) est réglée à estimate=100 par l'orchestrateur avant ce test. */
test.use({ storageState: authFile('ADMIN_MANAGER') });

test('tarification : estimation hors bornes (100) → pré-remplie, SANS avertissement ni aide au calcul', async ({
  page,
}) => {
  await page.goto('/tickets/ticket/ticket-list?di=DI_13yR&action=pricing', {
    waitUntil: 'domcontentloaded',
  });
  const input = page.locator('#pricing-init-input');
  await expect(input).toBeVisible({ timeout: 30_000 });
  // Pré-rempli à 100 (l'estimation, telle quelle — pas ramené à 150).
  await expect(input).toHaveValue(/100/, { timeout: 15_000 });

  // L'estimation fait RÉFÉRENCE → l'avertissement bornes 150–500 est TU,
  // même si 100 est hors bornes.
  await expect(page.locator('.pricing-warn')).toHaveCount(0);
  // Aide au calcul RETIRÉE : ni boutons de majoration, ni indicateur de marge.
  await expect(page.locator('.pricing-chips')).toHaveCount(0);
  await expect(page.locator('.pricing-ecart')).toHaveCount(0);
  // La note « Estimation à la création » reste (référence + traçabilité).
  await expect(page.locator('.pricing-estimate-orig')).toContainText('100');

  // Le prix est VERROUILLÉ (issu de l'estimation, non modifiable).
  await expect(input).toBeDisabled();

  // Renseigner l'estimation réparation (gate séparé et légitime) — si présente.
  const rep = page.locator('#pricing-repair-estimate');
  if (await rep.count()) {
    await rep.fill('200');
    await rep.blur();
  }
  // Le prix (100, hors bornes recommandées) ne bloque PAS la soumission.
  const validate = page.getByRole('button', { name: /Valider le prix/ });
  await expect(validate).toBeEnabled({ timeout: 10_000 });
});
