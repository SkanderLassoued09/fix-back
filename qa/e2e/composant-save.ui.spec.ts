import { test, expect } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Magasin « Affectation pour les composants » modal — « Enregistrer » UI flow.
 *
 * Reproduces the real user path and locks the bug fix:
 *  - editing a field + Enregistrer persists WITHOUT validating/greying the line;
 *  - the block-UI spinner ALWAYS stops (it used to hang forever);
 *  - exactly one success toast; the button never freezes.
 *
 * Seeds a self-contained MagasinEstimation DI + its component directly in Mongo
 * (test DB is throwaway) and hard-deletes them afterwards.
 */

test.use({ storageState: authFile('MAGASIN') });

const ROUTE = '/tickets/ticket/magasin-di-list';
const TAG = Date.now().toString(36);
const cmpId = `Cmp_uiqa_${TAG}`;
const cmpName = `QA UI Cmp ${TAG}`;
const diId = `DI_uiqa_${TAG}`;
const diNum = `UIQA-${TAG}`;

test.beforeAll(async () => {
    await withDb(async (db) => {
        await db.collection('composants').insertOne({
            _id: cmpId,
            name: cmpName,
            package: 'old-pkg',
            category_composant_id: 'CAT-UI',
            prix_achat: 1,
            prix_vente: 2,
            coming_date: '2026-06-10',
            link: 'http://parts.tn/old',
            quantity_stocked: 5,
            pdf: null,
            status_composant: 'En stock',
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: diNum,
            title: `QA UI DI ${TAG}`,
            description: 'magasin save test',
            contain_pdr: true,
            status: 'MagasinEstimation',
            current_roles: ['Magasin'],
            isDeleted: false,
            ignoreCount: 0,
            array_composants: [
                { nameComposant: cmpName, quantity: 2, isUpdated: false },
            ],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('composants').deleteOne({ _id: cmpId });
        await db.collection('dis').deleteOne({ _id: diId });
    });
});

test('Enregistrer persists the edit, stops the spinner, one toast, button stays active', async ({
    page,
}) => {
    await page.goto(ROUTE);

    // Open the « Affectation Estimation » modal for our seeded DI row. The
    // button has only a tooltip (no accessible name), so target it by its icon;
    // it's the one enabled for a MagasinEstimation row.
    const row = page.locator('tr', { hasText: diNum });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.locator('button:has(.pi-folder-open)').click();

    // The modal opens and auto-loads the first pending component into the form.
    await expect(page.locator('.cmp-assign')).toBeVisible({ timeout: 10000 });
    const nameInput = page.locator('input[formcontrolname="name"]');
    await expect(nameInput).toHaveValue(cmpName, { timeout: 10000 });

    // Edit a field (package).
    const newPkg = `pkg-${TAG}`;
    const pkgInput = page.locator('input[formcontrolname="package"]');
    await pkgInput.fill(newPkg);

    const saveBtn = page.locator('.cmp-btn--save');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Confirm the PrimeNG dialog.
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();

    // Exactly one SUCCESS toast, and no error toast.
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await expect(page.locator('.p-toast-message-error')).toHaveCount(0);

    // The block-UI spinner must be gone (this is the bug: it used to hang).
    await expect(page.locator('.p-blockui')).toBeHidden({ timeout: 8000 });

    // The button is never frozen.
    await expect(saveBtn).toBeEnabled();

    // The line is NOT validated/greyed by « Enregistrer » (that's « Valider »).
    await expect(
        page.locator('.cmp-detail__foot .cmp-validate'),
    ).toBeVisible();

    // Persistence proof — the new value is in the DB.
    await withDb(async (db) => {
        const doc = await db
            .collection('composants')
            .findOne({ _id: cmpId });
        expect(doc?.package).toBe(newPkg);
    });
});

test('on a save error, the spinner stops, one error toast, button stays active', async ({
    page,
}) => {
    // Fail only the save mutation (let every other GraphQL call through).
    await page.route('**/graphql', async (route) => {
        const body = route.request().postData() || '';
        if (body.includes('addComposantInfo')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    data: null,
                    errors: [
                        {
                            message: 'Simulated failure',
                            extensions: { code: 'INTERNAL_SERVER_ERROR' },
                        },
                    ],
                }),
            });
        } else {
            await route.continue();
        }
    });

    await page.goto(ROUTE);
    const row = page.locator('tr', { hasText: diNum });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.locator('button:has(.pi-folder-open)').click();
    await expect(page.locator('.cmp-assign')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('input[formcontrolname="name"]')).toHaveValue(
        cmpName,
        { timeout: 10000 },
    );

    await page.locator('input[formcontrolname="package"]').fill('will-fail');
    const saveBtn = page.locator('.cmp-btn--save');
    await saveBtn.click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();

    // One error toast, no success toast.
    await expect(page.locator('.p-toast-message-error')).toHaveCount(1, {
        timeout: 12000,
    });
    await expect(page.locator('.p-toast-message-success')).toHaveCount(0);

    // The spinner is released and the button is NOT frozen — the whole point.
    await expect(page.locator('.p-blockui')).toBeHidden({ timeout: 8000 });
    await expect(saveBtn).toBeEnabled();
});
