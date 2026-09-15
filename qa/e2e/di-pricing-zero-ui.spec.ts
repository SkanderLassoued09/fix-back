import { test, expect } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Tarification — « Prix du diagnostic à facturer ? » accepte 0 sur le FLUX
 * ORIGINAL (cycle 0) et sur une DI irréparable, plus seulement en retour :
 * « Valider le prix » s'active à 0, et le back enregistre 0.
 * Un champ VIDE reste bloquant (il faut saisir une valeur).
 */

const TICKET_LIST = '/tickets/ticket/ticket-list';
const tag = `pz_${Date.now().toString(36)}`;
const repId = `DI_${tag}_rep`;
const repNum = `PZR-${tag.toUpperCase()}`;
const irrId = `DI_${tag}_irr`;
const irrNum = `PZI-${tag.toUpperCase()}`;
const IDS = [repId, irrId];

test.use({ storageState: authFile('ADMIN_MANAGER') });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    await withDb(async (db) => {
        const now = new Date();
        // Cycle 0, PRICING_DIAG, payant, SANS estimation de création : le
        // champ prix est libre (pas de verrou sur l'estimation).
        const base = {
            status: 'PRICING_DIAG',
            ignoreCount: 0,
            contain_pdr: false,
            isErrorFromFixtronix: false,
            diagnosticPayant: true,
            diagnosticEstimate: null,
            client_id: 'C1',
            current_roles: ['Admin_Manager'],
            array_composants: [],
            isDeleted: false,
            statusUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
        };
        await db.collection('dis').insertMany([
            { ...base, _id: repId, _idnum: repNum, title: 'QA prix diag 0 (réparable)', can_be_repaired: true },
            { ...base, _id: irrId, _idnum: irrNum, title: 'QA prix diag 0 (irréparable)', can_be_repaired: false },
        ] as any[]);
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteMany({ _id: { $in: IDS } } as any);
        await db.collection('logsdis').deleteMany({ _idDi: { $in: IDS } });
        await db.collection('stats').deleteMany({ _idDi: { $in: IDS } });
        await db.collection('notifications').deleteMany({ diId: { $in: IDS } });
    });
});

async function openPricing(page: any, idnum: string) {
    await page.goto(TICKET_LIST);
    await page.evaluate(() =>
        document.getElementById('webpack-dev-server-client-overlay')?.remove(),
    );
    const row = page.locator('tr', { hasText: idnum });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.locator('button:has(.pi-dollar)').first().click();
    const priceInput = page.locator('#pricing-init-input');
    await expect(priceInput).toBeVisible({ timeout: 15_000 });
    await expect(priceInput).toBeEnabled();
    return priceInput;
}

test('flux original : prix du diagnostic à 0 → « Valider le prix » actif, 0 enregistré', async ({
    page,
}) => {
    const priceInput = await openPricing(page, repNum);
    const submit = page.locator('button.pricing-submit');

    // Champ vide : bloquant.
    await expect(submit).toBeDisabled();

    await priceInput.click();
    await priceInput.pressSequentially('0');
    const repair = page.locator('#pricing-repair-estimate');
    await repair.click();
    await repair.pressSequentially('300');
    await expect(priceInput).toHaveValue(/^0/);
    await expect(page.locator('.pricing-status')).toContainText('Tout est prêt');
    await expect(submit).toBeEnabled();

    // Validation réelle : le back accepte 0 sur le cycle 0.
    await submit.click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();
    await expect
        .poll(
            async () =>
                (await withDb((db) =>
                    db.collection('dis').findOne({ _id: repId } as any),
                ))?.status,
            { timeout: 15_000 },
        )
        .toBe('WAITING_DEVIS');
    const di = await withDb((db) =>
        db.collection('dis').findOne({ _id: repId } as any),
    );
    expect(di?.price).toBe(0);
});

test('irréparable (cycle 0) : prix du diagnostic à 0 → « Valider le prix » actif', async ({
    page,
}) => {
    const priceInput = await openPricing(page, irrNum);
    const submit = page.locator('button.pricing-submit');
    await expect(submit).toBeDisabled();

    await priceInput.click();
    await priceInput.pressSequentially('0');
    await expect(priceInput).toHaveValue(/^0/);
    await expect(page.locator('.pricing-status')).toContainText('Tout est prêt');
    await expect(submit).toBeEnabled();
});
