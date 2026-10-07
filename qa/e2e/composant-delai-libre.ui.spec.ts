import { test, expect } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * « Délai estimatif » (ex-« Date d'arrivée ») = TEXTE LIBRE dans `coming_date`.
 *
 * Le piège : la sérialisation passait par `gqlDateLiteral`, qui réduisait tout
 * texte non-date à "" — la saisie était perdue en silence. On vérifie aussi
 * qu'une ancienne date ISO est préremplie en « JJ/MM/AAAA ».
 */

test.use({ storageState: authFile('MAGASIN') });

const ROUTE = '/tickets/ticket/magasin-di-list';
const TAG = Date.now().toString(36);
const cmpId = `Cmp_delai_${TAG}`;
const name = `QA DELAI Cmp ${TAG}`;
const di = { _id: `DI_delai_${TAG}`, _idnum: `DELAI-${TAG}` };

test.beforeAll(async () => {
    await withDb(async (db) => {
        await db.collection('composants').insertOne({
            _id: cmpId,
            name,
            package: 'TO-220',
            category_composant_id: 'C_Composant3',
            prix_achat: 10,
            prix_vente: 15,
            coming_date: '2026-08-06',
            link: '',
            quantity_stocked: 4,
            pdf: '',
            status_composant: 'En stock',
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await db.collection('dis').insertOne({
            ...di,
            title: `QA DELAI DI ${TAG}`,
            contain_pdr: true,
            status: 'MagasinEstimation',
            current_roles: ['Magasin'],
            isDeleted: false,
            ignoreCount: 0,
            array_composants: [{ nameComposant: name, quantity: 1, isUpdated: false }],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('composants').deleteMany({ _id: cmpId });
        await db.collection('dis').deleteMany({ _id: di._id });
    });
});

test('délai estimatif saisi en texte libre puis persisté tel quel', async ({ page }) => {
    await page.goto(ROUTE);
    await page.evaluate(() =>
        document.getElementById('webpack-dev-server-client-overlay')?.remove(),
    );
    await expect(async () => {
        const row = page.locator('tr', { hasText: di._idnum });
        if ((await row.count()) === 0) await page.reload();
        await expect(row).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    await page.locator('tr', { hasText: di._idnum }).locator('button:has(.pi-folder-open)').click();
    await expect(page.locator('.cmp-assign')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('input[formcontrolname="name"]')).toHaveValue(name, {
        timeout: 10000,
    });

    await expect(page.locator('.cmp-assign')).toContainText('Délai estimatif');
    await expect(page.locator('.cmp-assign')).not.toContainText("Date d'arrivée");
    const delai = page.locator('input[formcontrolname="coming_date"]');
    await expect(delai).toHaveValue('06/08/2026');

    await delai.fill('2 semaines');
    await page.locator('.cmp-btn--save').click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, { timeout: 12000 });

    await withDb(async (db) => {
        const doc = await db.collection('composants').findOne({ _id: cmpId });
        expect(doc.coming_date).toBe('2 semaines');
    });
});
