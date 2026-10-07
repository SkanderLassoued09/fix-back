import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';
import { getAuthToken, gql } from './_helpers';

/**
 * FIX-229 — le modal « Estimation magasin » suit le catalogue EN TEMPS RÉEL.
 *
 * Le tech a demandé un composant dont la fiche est incomplète (package,
 * catégorie vides). Pendant que le magasin a le modal OUVERT, quelqu'un
 * complète la fiche depuis le catalogue (même mutation `addComposantInfo`,
 * envoyée ici par un autre compte) → le formulaire se met à jour sans clic.
 * Puis renommage sur une DI en retour (cycle 1, lignes lues dans `logsdis`) →
 * la ligne suit le nouveau nom au lieu de devenir « introuvable ».
 */

test.use({ storageState: authFile('MAGASIN') });
test.describe.configure({ mode: 'serial' });

const ROUTE = '/tickets/ticket/magasin-di-list';
const TAG = Date.now().toString(36);
const cmpId = `Cmp_live_${TAG}`;
const name = `QA LIVE Cmp ${TAG}`;
const CAT = 'C_Composant3';
const di0 = { _id: `DI_live0_${TAG}`, _idnum: `LIVE0-${TAG}` };
const di1 = { _id: `DI_live1_${TAG}`, _idnum: `LIVE1-${TAG}` };

const SAVE = `mutation($i: CreateComposantInput!){
  addComposantInfo(updateComposant:$i){ _id name package category_composant_id }
}`;

const diDoc = (d: { _id: string; _idnum: string }, ignoreCount: number) => ({
    ...d,
    title: `QA LIVE DI ${TAG}`,
    contain_pdr: true,
    status: 'MagasinEstimation',
    current_roles: ['Magasin'],
    isDeleted: false,
    ignoreCount,
    array_composants: [{ nameComposant: name, quantity: 3, isUpdated: false }],
    createdAt: new Date(),
    updatedAt: new Date(),
});

test.beforeAll(async () => {
    await withDb(async (db) => {
        await db.collection('composants').insertOne({
            _id: cmpId,
            name,
            package: '',
            category_composant_id: '',
            prix_achat: 0,
            prix_vente: 0,
            coming_date: '',
            link: '',
            quantity_stocked: 4,
            pdf: '',
            status_composant: 'En stock',
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await db.collection('dis').insertMany([diDoc(di0, 0), diDoc(di1, 1)]);
        await db.collection('logsdis').insertOne({
            _idDi: di1._id,
            idIgnore: 1,
            array_composants: [
                { nameComposant: name, quantity: 3, isUpdated: false },
            ],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('composants').deleteMany({ _id: cmpId });
        await db.collection('dis').deleteMany({ _id: { $in: [di0._id, di1._id] } });
        await db.collection('logsdis').deleteMany({ _idDi: di1._id });
    });
});

async function openModal(page: Page, diNum: string) {
    await expect(async () => {
        const row = page.locator('tr', { hasText: diNum });
        if ((await row.count()) === 0) await page.reload();
        await expect(row).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    await page
        .locator('tr', { hasText: diNum })
        .locator('button:has(.pi-folder-open)')
        .click();
    await expect(page.locator('.cmp-assign')).toBeVisible({ timeout: 10000 });
}

test('fiche complétée dans le catalogue → modal ouvert mis à jour sans clic', async ({
    page,
    request,
}) => {
    await page.goto(ROUTE);
    await openModal(page, di0._idnum);
    const pkg = page.locator('input[formcontrolname="package"]');
    await expect(page.locator('input[formcontrolname="name"]')).toHaveValue(
        name,
        { timeout: 10000 },
    );
    await expect(pkg).toHaveValue('');

    // « Catalogue composants » (autre poste) complète la fiche.
    const token = await getAuthToken(request);
    const r = await gql(request, token, SAVE, {
        i: { _id: cmpId, package: 'TO-220', category_composant_id: CAT },
    });
    expect(r.errors ?? [], JSON.stringify(r.errors)).toHaveLength(0);

    // Temps réel : aucune interaction côté magasin.
    await expect(pkg).toHaveValue('TO-220', { timeout: 10000 });
});

test('renommage dans le catalogue → DI en retour (logsdis) suit le nouveau nom', async ({
    page,
    request,
}) => {
    const token = await getAuthToken(request);
    const newName = `${name} V2`;
    const r = await gql(request, token, SAVE, {
        i: { _id: cmpId, name: newName },
    });
    expect(r.errors ?? [], JSON.stringify(r.errors)).toHaveLength(0);

    await withDb(async (db) => {
        const log = await db.collection('logsdis').findOne({ _idDi: di1._id });
        expect(log.array_composants[0].nameComposant).toBe(newName);
    });

    await page.goto(ROUTE);
    await openModal(page, di1._idnum);
    await expect(page.locator('input[formcontrolname="name"]')).toHaveValue(
        newName,
        { timeout: 10000 },
    );
    await expect(page.locator('input[formcontrolname="package"]')).toHaveValue(
        'TO-220',
    );
});
