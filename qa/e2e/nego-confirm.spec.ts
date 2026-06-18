import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * M5 — `confirmerNegociation` (confirm final price) migrated to MutationRunner.
 *
 * Proves the 3 branches + serialized cascade:
 *   B1  !contain_pdr            → PENDING3
 *   B2  !can_be_repaired        → FINISHED
 *   B3  contain_pdr && repairable → INMAGASIN
 * plus: serialized (price → transition), a failed price step aborts the
 * transition (status unchanged), double-click fires one cascade, one toast.
 *
 * Confirmer is enabled via ignoreCount>0 (the documented gating bypass — that
 * bypass itself is M3's concern; here it's only used to reach the cascade).
 *
 * gql: managerAdminManager_InMagasin (price), changeStatusPending3 /
 * changestatusToFinishReparation / changeStatusInMagasin (transitions).
 */

const TICKET_LIST = '/tickets/ticket/ticket-list';
test.use({ storageState: authFile('MANAGER') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);

async function seedNego(
    suffix: string,
    opts: { containPdr: boolean; canRepair: boolean },
): Promise<{ diId: string; idnum: string }> {
    const diId = `DI_nego_${TAG}_${suffix}`;
    const statId = `STAT_nego_${TAG}_${suffix}`;
    const idnum = `NEGO-${TAG}-${suffix}`;
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: `QA Nego ${suffix}`,
            status: 'NEGOTIATION1',
            contain_pdr: opts.containPdr,
            can_be_repaired: opts.canRepair,
            price: 100,
            final_price: 80,
            client_id: client?._id ?? null,
            array_composants: [],
            current_roles: ['Manager'],
            ignoreCount: 1, // >0 → Confirmer enabled without BC/Devis (M3 bypass)
            isDeleted: false,
            statusUpdatedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await db.collection('stats').insertOne({
            _id: statId,
            _idDi: diId,
            diRef: diId,
            status: 'NEGOTIATION1',
            ignoreCount: 1,
            diag_time: '00:00:00',
            rep_time: '',
            pauseLogs: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        // ignoreCount>0 routes the price save through logsDi.savePricing
        // (findOneAndUpdate, no upsert) — seed the matching LogsDi so it
        // returns non-null (else the non-nullable mutation field errors).
        await db.collection('logsdis').insertOne({
            _id: `LOG_nego_${TAG}_${suffix}`,
            _idDi: diId,
            idIgnore: 1,
            price: 100,
            final_price: 80,
            // The branch reads selectedRowInNegociate1 = the latest logsDi entry
            // (ignoreCount>0 path), so it must carry the repair flags too.
            contain_pdr: opts.containPdr,
            can_be_repaired: opts.canRepair,
            array_composants: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
    return { diId, idnum };
}

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteMany({ _id: { $regex: `_nego_${TAG}_` } });
        await db
            .collection('stats')
            .deleteMany({ _id: { $regex: `_nego_${TAG}_` } });
        await db
            .collection('logsdis')
            .deleteMany({ _id: { $regex: `_nego_${TAG}_` } });
    });
});

async function dbStatus(diId: string): Promise<string | undefined> {
    return withDb(async (db) => {
        const d = await db.collection('dis').findOne({ _id: diId });
        return d?.status;
    });
}

async function openNego(page: Page, idnum: string) {
    // The MANAGER list (~50 DIs + counters) takes a few seconds to load; a plain
    // wait is more reliable than reload-looping (which would reset the load).
    const row = page.locator('tr', { hasText: idnum });
    await expect(row).toBeVisible({ timeout: 20000 });
    await row.locator('button:has(.pi-dollar)').click();
    await expect(page.locator('.pricing-modal')).toBeVisible({ timeout: 10000 });
}

async function clickConfirmer(page: Page) {
    await page
        .getByRole('button', { name: 'Confirmer' })
        .last()
        .click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();
}

test('B1 !contain_pdr → PENDING3', async ({ page }) => {
    const s = await seedNego('B1', { containPdr: false, canRepair: true });
    await page.goto(TICKET_LIST);
    await openNego(page, s.idnum);
    await clickConfirmer(page);
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await expect.poll(() => dbStatus(s.diId), { timeout: 12000 }).toBe('PENDING3');
});

test('B2 !can_be_repaired → FINISHED', async ({ page }) => {
    const s = await seedNego('B2', { containPdr: false, canRepair: false });
    await page.goto(TICKET_LIST);
    await openNego(page, s.idnum);
    await clickConfirmer(page);
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await expect.poll(() => dbStatus(s.diId), { timeout: 12000 }).toBe('FINISHED');
});

test('B3 contain_pdr && repairable → INMAGASIN', async ({ page }) => {
    const s = await seedNego('B3', { containPdr: true, canRepair: true });
    await page.goto(TICKET_LIST);
    await openNego(page, s.idnum);
    await clickConfirmer(page);
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await expect.poll(() => dbStatus(s.diId), { timeout: 12000 }).toBe('INMAGASIN');
});

test('double-click Confirmer → price ×1 + transition ×1, one toast', async ({
    page,
}) => {
    const s = await seedNego('DC', { containPdr: false, canRepair: true });
    let price = 0;
    let transition = 0;
    page.on('request', (req) => {
        if (!req.url().includes('/graphql') || req.method() !== 'POST') return;
        const b = req.postData() || '';
        if (b.includes('managerAdminManager_InMagasin')) price++;
        if (b.includes('changeStatusPending3')) transition++;
    });
    await page.goto(TICKET_LIST);
    await openNego(page, s.idnum);
    const btn = page.getByRole('button', { name: 'Confirmer' }).last();
    await btn.click();
    await btn.click({ force: true }).catch(() => {});
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await page.waitForTimeout(1500);
    expect(price, `price ×${price}`).toBe(1);
    expect(transition, `transition ×${transition}`).toBe(1);
});

test('price step fails → transition NOT fired, status unchanged, modal open', async ({
    page,
}) => {
    const s = await seedNego('ERR', { containPdr: false, canRepair: true });
    let transition = 0;
    await page.route('**/graphql', async (route) => {
        const b = route.request().postData() || '';
        if (b.includes('changeStatusPending3')) transition++;
        if (b.includes('managerAdminManager_InMagasin')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    data: null,
                    errors: [
                        { message: 'Simulated price failure', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
                    ],
                }),
            });
        } else {
            await route.continue();
        }
    });
    await page.goto(TICKET_LIST);
    await openNego(page, s.idnum);
    await clickConfirmer(page);
    await expect(page.locator('.p-toast-message-error')).toHaveCount(1, {
        timeout: 12000,
    });
    await page.waitForTimeout(1000);
    expect(transition, 'transition must NOT fire after a failed price step').toBe(0);
    expect(await dbStatus(s.diId), 'status unchanged').toBe('NEGOTIATION1');
    await expect(page.locator('.pricing-modal')).toBeVisible();
});
