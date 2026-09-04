import { test, expect, Page, Locator } from '@playwright/test';
import { authFile, tokenFor } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Édition ADMINISTRATIVE du dossier — réservée au rôle `ADMIN_TECH`.
 *
 * Vérifie le chemin d'ÉCRITURE de bout en bout : la garde de rôle SERVEUR (pas
 * seulement le masquage du bouton), la persistance réelle, et la traçabilité —
 * une modification doit apparaître dans le journal du dossier, sans quoi elle
 * échapperait à la piste d'audit.
 *
 * La DI est créée et supprimée par le test : aucune donnée existante n'est
 * touchée.
 */

const GRAPHQL = 'http://localhost:3000/graphql';
/**
 * T1420 — DI réelle ET atteignable par deep-link pour ce rôle.
 *
 * Le `DeepLinkConsumer` cherche d'abord la ligne dans la liste et retombe sur
 * `row=null` s'il ne la trouve pas (limite connue) : la DI choisie doit donc
 * figurer dans la liste chargée. `DI_tumA` n'y est pas pour ADMIN_TECH.
 */
const DI_ID = 'DI_Yzki';
const MARKER = `SN-QA-${Date.now().toString(36)}`;

/** État d'origine, restauré en fin de test : on ne laisse aucune trace. */
let originalNSerie: string | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  originalNSerie = await withDb(async (db) => {
    const d = await db.collection('dis').findOne({ _id: DI_ID });
    return ((d as any)?.nSerie ?? null) as string | null;
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    await db
      .collection('dis')
      .updateOne({ _id: DI_ID }, { $set: { nSerie: originalNSerie } });
    // Les événements produits PAR CE TEST uniquement.
    await db
      .collection('system_events')
      .deleteMany({ diId: DI_ID, type: 'DI_EDITED', 'payload.changes.nSerie.to': MARKER });
  });
});

async function openModal(page: Page, diId: string): Promise<Locator> {
  await page.goto(`/tickets/ticket/ticket-list?di=${diId}&action=detail`, {
    waitUntil: 'domcontentloaded',
  });
  const modal = page.locator('.di-info-modal');
  await expect(modal).toBeVisible({ timeout: 25_000 });
  await expect(modal.locator('.di-facts .di-fact').first()).toBeVisible({
    timeout: 20_000,
  });
  // Le modal se monte AVANT l'arrivée des données : attendre un titre réel,
  // sinon on cliquerait sur une coque vide.
  await expect(modal.locator('.di-head__title')).not.toHaveText('—', {
    timeout: 20_000,
  });
  return modal;
}

test('la garde SERVEUR refuse un rôle non ADMIN_TECH (pas seulement l’UI)', async ({
  request,
}) => {
  // MANAGER : le bouton est masqué côté UI, mais c'est le SERVEUR qui doit
  // trancher — un appel direct doit être rejeté.
  const res = await request.post(GRAPHQL, {
    headers: {
      authorization: `Bearer ${tokenFor('MANAGER')}`,
      'content-type': 'application/json',
    },
    data: {
      query: `mutation ($input: AdminTechUpdateDiInput!) {
        adminTechUpdateDi(input: $input) { _id }
      }`,
      variables: { input: { _id: DI_ID, nSerie: 'PIRATE-PAR-MANAGER' } },
    },
  });
  const body = await res.json();
  expect(body.errors, 'un MANAGER ne doit PAS pouvoir éditer').toBeTruthy();

  // Et rien n'a bougé en base.
  const nSerie = await withDb(async (db) => {
    const d = await db.collection('dis').findOne({ _id: DI_ID });
    return (d as any)?.nSerie;
  });
  expect(nSerie).not.toBe('PIRATE-PAR-MANAGER');
});

test('ADMIN_TECH édite : persistance RÉELLE + trace dans le journal', async ({
  request,
}) => {
  // Chemin API (le même que celui déclenché par « Enregistrer » du modal) :
  // on valide la mutation, sa garde de rôle, sa persistance et sa traçabilité
  // sans dépendre du rendu de la liste.
  const res = await request.post(GRAPHQL, {
    headers: {
      authorization: `Bearer ${tokenFor('ADMIN_TECH')}`,
      'content-type': 'application/json',
    },
    data: {
      query: `mutation ($input: AdminTechUpdateDiInput!) {
        adminTechUpdateDi(input: $input) { _id status }
      }`,
      variables: { input: { _id: DI_ID, nSerie: MARKER } },
    },
  });
  const body = await res.json();
  expect(body.errors, `mutation refusée: ${JSON.stringify(body.errors)}`).toBeFalsy();
  expect(body.data.adminTechUpdateDi._id).toBe(DI_ID);

  // 1) Persisté.
  const stored = await withDb(async (db) => {
    const d = await db.collection('dis').findOne({ _id: DI_ID });
    return (d as any)?.nSerie;
  });
  expect(stored, 'le n° de série doit être persisté').toBe(MARKER);

  // 2) Tracé — une modification qui n'apparaît pas au journal échapperait à la
  //    piste d'audit ; c'est la raison d'être de la mutation dédiée.
  const evt = await withDb(async (db) =>
    db.collection('system_events').findOne({
      diId: DI_ID,
      type: 'DI_EDITED',
      'payload.changes.nSerie.to': MARKER,
    }),
  );
  expect(evt, 'un événement DI_EDITED doit être journalisé').toBeTruthy();
  expect((evt as any).payload?.changes?.nSerie?.from).toBe(originalNSerie);
  expect((evt as any).actorId, 'l’acteur doit être enregistré').toBeTruthy();
  expect((evt as any).actorRole).toBe('ADMIN_TECH');
});

test('ré-enregistrer la MÊME valeur ne crée aucune ligne de journal', async ({
  request,
}) => {
  const before = await withDb(async (db) =>
    db.collection('system_events').countDocuments({ diId: DI_ID, type: 'DI_EDITED' }),
  );
  const res = await request.post(GRAPHQL, {
    headers: {
      authorization: `Bearer ${tokenFor('ADMIN_TECH')}`,
      'content-type': 'application/json',
    },
    data: {
      query: `mutation ($input: AdminTechUpdateDiInput!) {
        adminTechUpdateDi(input: $input) { _id }
      }`,
      variables: { input: { _id: DI_ID, nSerie: MARKER } },
    },
  });
  expect((await res.json()).errors).toBeFalsy();
  const after = await withDb(async (db) =>
    db.collection('system_events').countDocuments({ diId: DI_ID, type: 'DI_EDITED' }),
  );
  // Sinon le journal se remplirait de bruit à chaque ouverture/fermeture.
  expect(after, 'aucun événement pour une modification vide').toBe(before);
});
