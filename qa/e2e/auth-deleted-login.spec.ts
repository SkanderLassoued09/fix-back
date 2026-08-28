import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { loginViaUI } from '../utils/auth';
import { accountByKey } from '../utils/roles';

/**
 * feat/block-deleted-profile-login — validation UI : un profil SUPPRIMÉ
 * (`isDeleted: true`) ne peut PAS se connecter via l'écran de login, même avec
 * les bons identifiants. On soft-delete le compte TECH, on tente une connexion
 * réelle et on vérifie le REFUS (aucun token, message serveur « désactivé »,
 * toujours sur /auth/login). Un test témoin confirme que le même compte
 * RÉACTIVÉ se connecte normalement (la garde est spécifique, pas globale).
 */

const tech = accountByKey('TECH');

const setProfile = (patch: Record<string, any>) =>
  withDb((db) =>
    db
      .collection('profiles')
      .updateOne({ username: tech.username }, { $set: patch }),
  );

// Filet de sécurité : le compte de test est TOUJOURS réactivé + libéré, même si
// un test échoue, pour ne jamais laisser le compte cassé.
test.afterEach(async () => {
  await setProfile({ isDeleted: false, isConnected: false });
});

test('profil supprimé (isDeleted:true) → connexion REFUSÉE + message « désactivé »', async ({
  page,
}) => {
  await setProfile({ isDeleted: true, isConnected: false });

  const res = await loginViaUI(page, tech);

  // Aucun token (login échoué), message serveur clair, on reste sur /auth/login.
  expect(res.ok).toBe(false);
  expect(res.token).toBeNull();
  expect(JSON.stringify(res.errors ?? [])).toMatch(/désactivé/);
  await expect(page).toHaveURL(/\/auth\/login/);
});

test('témoin : le même compte RÉACTIVÉ se connecte normalement', async ({
  page,
}) => {
  await setProfile({ isDeleted: false, isConnected: false });

  const res = await loginViaUI(page, tech);

  expect(res.ok).toBe(true);
  expect(res.token).not.toBeNull();
  await expect(page).not.toHaveURL(/\/auth\/login/);
});
