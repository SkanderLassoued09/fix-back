import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';
import { techId } from '../utils/accounts';
import { getAuthToken, gql } from './_helpers';

/**
 * Type d'erreur d'un retour : en retour il n'y a que DEUX choix, « Erreur
 * Fixtronix » ou « Erreur Client » (jamais « non choisi »).
 *
 * UI (vrai wizard, compte TECH) — retour réparable SANS PDR, « Fin diagnostique
 * retour » :
 *   F — « Erreur Fixtronix » → PENDING3 (non facturé).
 *   C — « Erreur Client »    → PENDING2 (facturé).
 * API — retour réparable AVEC PDR, `changeStatusMagasinEstimation` :
 *   PF / PC — Fixtronix / Client → MagasinEstimation.
 */

const TECH_LIST = '/tickets/ticket/tech-di-list';
const TAG = Date.now().toString(36);
let TECH_ID = '';

test.use({ storageState: authFile('TECH') });

test.beforeAll(async () => {
    TECH_ID = await withDb(techId);
});

test.afterAll(async () => {
    const re = { $regex: `_errt_${TAG}_` };
    await withDb(async (db) => {
        await db.collection('dis').deleteMany({ _id: re });
        await db.collection('stats').deleteMany({ _idDi: re });
        await db.collection('logsdis').deleteMany({ _idDi: re });
        await db.collection('notifications').deleteMany({ diId: re });
    });
});

async function seedRetour(suffix: string, withPdr: boolean, verdict: boolean | null = null) {
    const diId = `DI_errt_${TAG}_${suffix}`;
    const idnum = `ERRT-${TAG}-${suffix}`;
    const composants = withPdr
        ? [{ nameComposant: 'QA ERRT', quantity: 1, isUpdated: false }]
        : [];
    await withDb(async (db) => {
        const client = await db.collection('clients').findOne({ isDeleted: { $ne: true } });
        const now = new Date();
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: `QA type erreur ${suffix}`,
            description: 'retour réparable',
            status: 'INDIAGNOSTIC',
            ignoreCount: 1,
            can_be_repaired: true,
            contain_pdr: withPdr,
            array_composants: composants,
            ...(verdict === null ? {} : { isErrorFromFixtronix: verdict }),
            di_category_id: 'CAT-ERRT',
            client_id: client?._id ?? null,
            createdBy: TECH_ID,
            current_workers_ids: [TECH_ID],
            current_roles: ['Tech'],
            isDeleted: false,
            statusUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
        });
        await db.collection('stats').insertOne({
            _id: `stat-${diId}`,
            _idDi: diId,
            diRef: diId,
            id_tech_diag: TECH_ID,
            id_tech_rep: TECH_ID,
            status: 'INDIAGNOSTIC',
            diag_time: '00:00:00',
            rep_time: '',
            ignoreCount: 1,
            retour_count: 1,
            pauseLogs: [],
            createdAt: now,
            updatedAt: now,
        });
        await db.collection('logsdis').insertOne({
            _id: `log-${diId}`,
            _idDi: diId,
            idIgnore: 1,
            can_be_repaired: true,
            contain_pdr: withPdr,
            array_composants: composants,
            isErrorFromFixtronix: verdict,
            createdAt: now,
            updatedAt: now,
        });
    });
    return { diId, idnum };
}

const dbDi = (diId: string) =>
    withDb<any>((db) => db.collection('dis').findOne({ _id: diId }));

async function openDiag(page: Page, idnum: string) {
    await page.goto(TECH_LIST);
    await page.evaluate(() =>
        document.getElementById('webpack-dev-server-client-overlay')?.remove(),
    );
    await expect(async () => {
        const row = page.locator('tr', { hasText: idnum });
        if ((await row.count()) === 0) await page.reload();
        await expect(row.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    await page.locator('tr', { hasText: idnum }).first().locator('button:has(.pi-search)').click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({ timeout: 10000 });
    await goStep(page, 'Panne');
    await page.locator('#diag-desc').fill('Panne relevée par le test E2E.');
    await page.locator('#diag-extra').fill('Remarque technicien E2E.');
}

const goStep = (page: Page, label: string) =>
    page.locator('.sav-stepper__btn', { hasText: label }).click();

const box = (page: Page, control: string) =>
    page.locator(`input[formcontrolname="${control}"]`);

async function setPdrOff(page: Page) {
    const pdr = box(page, 'isPdr');
    await expect(pdr).toBeVisible({ timeout: 8000 });
    if (await pdr.isChecked()) await pdr.click({ force: true });
    await expect(pdr).not.toBeChecked();
}

async function finishRetour(page: Page) {
    await goStep(page, 'Résumé');
    const btn = page.locator('.actions button', { hasText: 'Fin diagnostique retour' });
    await expect(btn).toBeEnabled({ timeout: 8000 });
    await btn.click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();
}

test('F — retour sans PDR, « Erreur Fixtronix » → PENDING3', async ({ page }) => {
    const s = await seedRetour('F', false);
    await openDiag(page, s.idnum);
    await goStep(page, 'Validation');
    await setPdrOff(page);
    const err = box(page, 'isErrorFromFixtronix');
    await err.click({ force: true });
    await expect(err).toBeChecked();
    await finishRetour(page);
    await expect.poll(async () => (await dbDi(s.diId))?.status, { timeout: 15000 }).toBe('PENDING3');
});

test('C — retour sans PDR, « Erreur Client » → PENDING2', async ({ page }) => {
    const s = await seedRetour('C', false);
    await openDiag(page, s.idnum);
    await goStep(page, 'Validation');
    await setPdrOff(page);
    // Case « Erreur de Fixtronix ? » décochée = Erreur Client.
    await expect(box(page, 'isErrorFromFixtronix')).not.toBeChecked();
    await finishRetour(page);
    await expect.poll(async () => (await dbDi(s.diId))?.status, { timeout: 15000 }).toBe('PENDING2');
});

const MAGASIN = `mutation($id: String!){ changeStatusMagasinEstimation(_id: $id) }`;

for (const [suffix, verdict] of [['PF', true], ['PC', false]] as const) {
    test(`${suffix} — API, retour avec PDR, ${verdict ? 'Fixtronix' : 'Client'} → MagasinEstimation`, async ({ request }) => {
        const s = await seedRetour(suffix, true, verdict);
        const r = await gql(request, await getAuthToken(request), MAGASIN, { id: s.diId });
        expect(r.errors ?? [], JSON.stringify(r.errors)).toHaveLength(0);
        expect((await dbDi(s.diId))?.status).toBe('MagasinEstimation');
    });
}
