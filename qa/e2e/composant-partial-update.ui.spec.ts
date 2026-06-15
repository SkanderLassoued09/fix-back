import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Magasin « Enregistrer » — the exact reported regression, via the real modal:
 * editing only the Nom must NOT empty the other fields on reopen (they used to
 * vanish and stock dropped to 0 because the rename orphaned the DI↔part link).
 *
 * Kept in its own file (not next to the API specs) so the browser flow runs
 * clean — co-locating it after a batch of API calls raced the dev servers.
 */

test.use({ storageState: authFile('MAGASIN') });

const ROUTE = '/tickets/ticket/magasin-di-list';
const TAG = Date.now().toString(36);
const id = `Cmp_puui_${TAG}`;
const name = `QA PUUI Cmp ${TAG}`;
const diId = `DI_puui_${TAG}`;
const diNum = `PUUI-${TAG}`;

test.beforeAll(async () => {
    await withDb(async (db) => {
        await db.collection('composants').insertOne({
            _id: id,
            name,
            package: 'PKG-ORIG',
            category_composant_id: 'CAT-ORIG',
            prix_achat: 11.5,
            prix_vente: 22.5,
            coming_date: '2026-06-10',
            link: 'http://parts.tn/orig',
            quantity_stocked: 77,
            pdf: 'datasheet-orig.pdf',
            status_composant: 'En stock',
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: diNum,
            title: `QA PUUI DI ${TAG}`,
            contain_pdr: true,
            status: 'MagasinEstimation',
            current_roles: ['Magasin'],
            isDeleted: false,
            array_composants: [
                { nameComposant: name, quantity: 2, isUpdated: false },
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

// Open the modal for our DI row, reloading once if the list came back empty
// (the dev backend/front can race a watch-recompile on first load).
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

test('edit only Nom → reopen: name changed, all other fields intact, stock kept', async ({
    page,
}) => {
    await page.goto(ROUTE);
    await openModal(page);
    await expect(page.locator('input[formcontrolname="name"]')).toHaveValue(
        name,
        { timeout: 10000 },
    );

    // Edit ONLY the Nom.
    const newName = `${name} R`;
    await page.locator('input[formcontrolname="name"]').fill(newName);
    await page.locator('.cmp-btn--save').click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });

    // CLOSE then RE-OPEN — the reported symptom.
    await page.locator('.cmp-btn--cancel').click();
    await expect(page.locator('.cmp-assign')).toBeHidden();
    await openModal(page);

    // The renamed row resolves and the form is fully populated (not empty).
    await expect(page.locator('input[formcontrolname="name"]')).toHaveValue(
        newName,
        { timeout: 10000 },
    );
    await expect(page.locator('input[formcontrolname="package"]')).toHaveValue(
        'PKG-ORIG',
    );
    await expect(page.locator('input[formcontrolname="link"]')).toHaveValue(
        'http://parts.tn/orig',
    );

    // DB proof: nothing wiped; coming_date stays a clean ISO date.
    await withDb(async (db) => {
        const doc = await db.collection('composants').findOne({ _id: id });
        expect(doc.name).toBe(newName);
        expect(doc.package).toBe('PKG-ORIG');
        expect(doc.prix_achat).toBe(11.5);
        expect(doc.quantity_stocked).toBe(77);
        expect(doc.pdf).toBe('datasheet-orig.pdf');
        expect(String(doc.coming_date)).not.toContain('GMT');
    });
});
