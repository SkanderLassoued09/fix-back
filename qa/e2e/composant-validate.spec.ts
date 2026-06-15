import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Magasin « Valider ce composant » (M6) via the central MutationRunner.
 *
 * Proves the new guarantees:
 *  - anti double-submit: a rapid double-click fires the save+validate chain
 *    ONCE (one addComposantInfo + one setComposantAsUpdated), one success toast;
 *  - serialized cascade: setComposantAsUpdated runs only after addComposantInfo.
 */

test.use({ storageState: authFile('MAGASIN') });

const ROUTE = '/tickets/ticket/magasin-di-list';
const TAG = Date.now().toString(36);
const cmpId = `Cmp_val_${TAG}`;
const cmpName = `QA Val Cmp ${TAG}`;
const diId = `DI_val_${TAG}`;
const diNum = `VAL-${TAG}`;

test.beforeAll(async () => {
    await withDb(async (db) => {
        await db.collection('composants').insertOne({
            _id: cmpId,
            name: cmpName,
            package: 'PKG',
            category_composant_id: 'CAT',
            prix_achat: 1,
            prix_vente: 2,
            coming_date: '2026-06-10',
            link: 'http://parts.tn',
            quantity_stocked: 50,
            pdf: null,
            status_composant: 'En stock',
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: diNum,
            title: `QA Val DI ${TAG}`,
            contain_pdr: true,
            status: 'MagasinEstimation',
            current_roles: ['Magasin'],
            isDeleted: false,
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
        await db.collection('composants').deleteMany({ name: { $regex: TAG } });
        await db.collection('dis').deleteMany({
            $or: [{ _id: { $regex: TAG } }, { _idnum: { $regex: TAG } }],
        });
    });
});

async function openModal(page: Page) {
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

test('double-click « Valider » → one save + one validate, one toast (anti double-submit)', async ({
    page,
}) => {
    // Count the two mutations the validate chain fires.
    let saveCount = 0;
    let validateCount = 0;
    page.on('request', (req) => {
        if (!req.url().includes('/graphql') || req.method() !== 'POST') return;
        const body = req.postData() || '';
        if (body.includes('addComposantInfo')) saveCount++;
        if (body.includes('setSelectedComponentAsDone')) validateCount++;
    });

    await page.goto(ROUTE);
    await openModal(page);
    await expect(page.locator('input[formcontrolname="name"]')).toHaveValue(
        cmpName,
        { timeout: 10000 },
    );

    // Rapid double-click on « Valider ce composant » (opens a confirm dialog).
    const validateBtn = page.locator('.cmp-validate');
    await expect(validateBtn).toBeEnabled();
    await validateBtn.click();
    await validateBtn.click({ force: true }).catch(() => {});
    // Accept the confirmation (PrimeNG) — once.
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();

    // The handshake completed exactly once.
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await expect(page.locator('.p-toast-message-error')).toHaveCount(0);
    await page.waitForTimeout(1500); // let any stray duplicate land

    expect(saveCount, `addComposantInfo fired ${saveCount}× (expected 1)`).toBe(1);
    expect(
        validateCount,
        `setSelectedComponentAsDone fired ${validateCount}× (expected 1)`,
    ).toBe(1);

    // The DI line is marked done (serialized cascade succeeded).
    await withDb(async (db) => {
        const di = await db.collection('dis').findOne({ _id: diId });
        const line = (di?.array_composants ?? []).find(
            (l: any) => l.nameComposant === cmpName,
        );
        expect(line?.isUpdated).toBe(true);
    });
});
