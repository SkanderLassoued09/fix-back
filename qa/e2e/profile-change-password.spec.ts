import { test, expect, Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * « Mon profil » — changement de mot de passe depuis le menu utilisateur.
 *
 * Parcours réel : avatar → « Mon profil » → saisie → Enregistrer. Vérifie la
 * validation côté client, le succès, la PERSISTANCE (hachée) et le fait que la
 * session est conservée.
 *
 * Le compte de test est remis à son mot de passe d'origine en fin de fichier.
 */

const USER = 'magasin';
const OLD = '123456';
const NEW = 'nouveauMdp2026';

/** Libère le verrou de session unique (`isConnected`) — sinon relogin refusé. */
async function unlock() {
  await withDb(async (db) => {
    await db
      .collection('profiles')
      .updateOne({ username: USER }, { $set: { isConnected: false } });
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(unlock);

test.afterAll(async () => {
  // Remise à l'état initial : hash bcrypt de `123456`, verrou libéré.
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash(OLD, 10);
  await withDb(async (db) => {
    await db
      .collection('profiles')
      .updateOne(
        { username: USER },
        { $set: { password: hash, isConnected: false } },
      );
  });
});

async function openProfileDialog(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).not.toHaveURL(/\/auth\/login/);
  await page.locator('.topbar-user__trigger').click();
  await page.getByRole('menuitem', { name: /Mon profil/ }).click();
  const dlg = page.locator('.p-dialog', { hasText: 'Mon profil' });
  await expect(dlg).toBeVisible({ timeout: 15_000 });
  return dlg;
}

test.use({ storageState: authFile('MAGASIN') });

test('le menu utilisateur expose « Mon profil » au-dessus de « Se déconnecter »', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.topbar-user__trigger').click();
  await expect(page.getByRole('menuitem', { name: /Mon profil/ })).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: /Se déconnecter/ }),
  ).toBeVisible();
});

test('validation client : trop court, non concordant, identique à l’actuel', async ({
  page,
}) => {
  const dlg = await openProfileDialog(page);
  const save = dlg.getByRole('button', { name: /Enregistrer/ });
  const cur = dlg.locator('#pwd-current');
  const next = dlg.locator('#pwd-next');
  const conf = dlg.locator('#pwd-confirm');

  await cur.fill(OLD);
  await next.fill('court');
  await conf.fill('court');
  await expect(dlg.locator('.fx-udlg__error')).toContainText('8 caractères');
  await expect(save).toBeDisabled();

  await next.fill('nouveauMdp2026');
  await conf.fill('autreChose123');
  await expect(dlg.locator('.fx-udlg__error')).toContainText('confirmation');
  await expect(save).toBeDisabled();

  const SAME = 'memeMdp12345';
  await cur.fill(SAME);
  await next.fill(SAME);
  await conf.fill(SAME);
  await expect(dlg.locator('.fx-udlg__error')).toContainText('différent');
  await expect(save).toBeDisabled();
});

test('mot de passe actuel FAUX → refus serveur, la modale reste ouverte', async ({
  page,
}) => {
  const dlg = await openProfileDialog(page);
  await dlg.locator('#pwd-current').fill('totalementFaux');
  await dlg.locator('#pwd-next').fill(NEW);
  await dlg.locator('#pwd-confirm').fill(NEW);
  await dlg.getByRole('button', { name: /Enregistrer/ }).click();
  // La saisie n'est pas perdue : l'utilisateur corrige sur place.
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.fx-udlg__error')).toContainText(/incorrect/i, {
    timeout: 15_000,
  });
  // La saisie est conservée telle quelle.
  await expect(dlg.locator('#pwd-next')).toHaveValue(NEW);
});

test('changement réussi → persistance HACHÉE et session conservée', async ({
  page,
}) => {
  const dlg = await openProfileDialog(page);
  await dlg.locator('#pwd-current').fill(OLD);
  await dlg.locator('#pwd-next').fill(NEW);
  await dlg.locator('#pwd-confirm').fill(NEW);
  await dlg.getByRole('button', { name: /Enregistrer/ }).click();

  await expect(dlg).toBeHidden({ timeout: 20_000 });
  // Session conservée : on reste sur l'app, pas de retour au login.
  await expect(page).not.toHaveURL(/\/auth\/login/);

  const stored = await withDb(async (db) => {
    const p = await db.collection('profiles').findOne({ username: USER });
    return (p as any)?.password as string;
  });
  // Le point critique : jamais en clair.
  expect(stored.startsWith('$2')).toBeTruthy();
  expect(stored).not.toBe(NEW);
  const bcrypt = require('bcrypt');
  expect(await bcrypt.compare(NEW, stored)).toBe(true);
  expect(await bcrypt.compare(OLD, stored)).toBe(false);
});
