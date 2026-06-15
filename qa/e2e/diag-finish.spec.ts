import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * M2 — diagnostic finish (`techFinishDiag`) migrated to MutationRunner.
 *
 * Proves:
 *  - branch preserved: pdr && reparable → MagasinEstimation, else → Pending2;
 *  - serialized cascade (saveTimeDiag → finish → transition);
 *  - anti double-submit: double-click → each mutation fires once, one toast;
 *  - error interrupts: a failed `finish` step does NOT run the transition,
 *    error toast shown, modal stays open, status unchanged (still INDIAGNOSTIC).
 *
 * gql fields: lapTimeForPauseAndGetBack (saveTimeDiag), tech_startDiagnostic
 * (finish), changeStatusMagasinEstimation / changeStatusPending2 (transition).
 */

const TECH_ID = '69fb49a8fbdfcb7ca81bed0e';
const TECH_LIST = '/tickets/ticket/tech-di-list';

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);

type Seed = { diId: string; statId: string; idnum: string };
const seeds: Seed[] = [];

async function seedDiag(
    suffix: string,
    opts: { containPdr: boolean; canRepair: boolean; withComposant: boolean },
): Promise<Seed> {
    const diId = `DI_diagfin_${TAG}_${suffix}`;
    const statId = `STAT_diagfin_${TAG}_${suffix}`;
    const idnum = `DGF-${TAG}-${suffix}`;
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: `QA Diag Finish ${suffix}`,
            description: 'staged for diag-finish M2',
            status: 'INDIAGNOSTIC',
            can_be_repaired: opts.canRepair,
            contain_pdr: opts.containPdr,
            di_category_id: 'CAT-DGF',
            client_id: client?._id ?? null,
            createdBy: TECH_ID,
            location_id: null,
            array_composants: opts.withComposant
                ? [{ nameComposant: `Cmp ${suffix}`, quantity: 1, isUpdated: false }]
                : [],
            current_workers_ids: [TECH_ID],
            current_roles: ['Tech'],
            isDeleted: false,
            statusUpdatedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await db.collection('stats').insertOne({
            _id: statId,
            _idDi: diId,
            diRef: diId,
            id_tech_diag: TECH_ID,
            id_tech_rep: TECH_ID,
            status: 'INDIAGNOSTIC',
            diag_time: '00:00:00',
            rep_time: '',
            ignoreCount: 0,
            retour_count: 0,
            pauseLogs: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
    const s = { diId, statId, idnum };
    seeds.push(s);
    return s;
}

test.afterAll(async () => {
    await withDb(async (db) => {
        await db
            .collection('dis')
            .deleteMany({ _id: { $regex: `_diagfin_${TAG}_` } });
        await db
            .collection('stats')
            .deleteMany({ _id: { $regex: `_diagfin_${TAG}_` } });
    });
});

async function dbStatus(diId: string): Promise<string | undefined> {
    return withDb(async (db) => {
        const d = await db.collection('dis').findOne({ _id: diId });
        return d?.status;
    });
}

async function openDiag(page: Page, idnum: string) {
    await expect(async () => {
        const row = page.locator('tr', { hasText: idnum });
        if ((await row.count()) === 0) await page.reload();
        await expect(row).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    await page
        .locator('tr', { hasText: idnum })
        .locator('button:has(.pi-search)')
        .click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({ timeout: 10000 });
}

/** Jump to a wizard step via the stepper button label. */
async function goStep(page: Page, label: string) {
    await page.locator('.sav-stepper__btn', { hasText: label }).click();
}

async function setToggle(page: Page, control: string, checked: boolean) {
    const box = page.locator(`input[formcontrolname="${control}"]`);
    if (checked) await box.check({ force: true });
    else await box.uncheck({ force: true });
}

async function clickFinish(page: Page) {
    await goStep(page, 'Résumé');
    const btn = page.locator('button.btn--primary', {
        hasText: 'Finir le diagnostic',
    });
    await expect(btn).toBeEnabled({ timeout: 8000 });
    await btn.click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();
}

test('branch pdr && reparable → MagasinEstimation', async ({ page }) => {
    const s = await seedDiag('A', {
        containPdr: true,
        canRepair: true,
        withComposant: true, // gating: pdr&&reparable needs a non-empty composant list
    });
    await page.goto(TECH_LIST);
    await openDiag(page, s.idnum);
    await goStep(page, 'Validation');
    await setToggle(page, 'isReparable', true);
    await setToggle(page, 'isPdr', true);
    await clickFinish(page);

    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await expect.poll(() => dbStatus(s.diId), { timeout: 12000 }).toBe(
        'MagasinEstimation',
    );
});

test('branch NOT (pdr && reparable) → Pending2', async ({ page }) => {
    // withComposant:true keeps the finish gate open (non-empty composant list);
    // unchecking isPdr makes the live form value drive the branch → Pending2.
    const s = await seedDiag('B', {
        containPdr: true,
        canRepair: true,
        withComposant: true,
    });
    await page.goto(TECH_LIST);
    await openDiag(page, s.idnum);
    await goStep(page, 'Validation');
    await setToggle(page, 'isReparable', true);
    await setToggle(page, 'isPdr', false);
    await clickFinish(page);

    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await expect.poll(() => dbStatus(s.diId), { timeout: 12000 }).toBe('PENDING2');
});

test('double-click Finir → each mutation fires once, one toast', async ({
    page,
}) => {
    const s = await seedDiag('C', {
        containPdr: true,
        canRepair: true,
        withComposant: true,
    });
    let saveTime = 0;
    let finish = 0;
    let transition = 0;
    page.on('request', (req) => {
        if (!req.url().includes('/graphql') || req.method() !== 'POST') return;
        const b = req.postData() || '';
        if (b.includes('lapTimeForPauseAndGetBack')) saveTime++;
        if (b.includes('tech_startDiagnostic')) finish++;
        if (b.includes('changeStatusPending2')) transition++;
    });

    await page.goto(TECH_LIST);
    await openDiag(page, s.idnum);
    await goStep(page, 'Validation');
    await setToggle(page, 'isReparable', true);
    await setToggle(page, 'isPdr', false);
    await goStep(page, 'Résumé');
    const btn = page.locator('button.btn--primary', {
        hasText: 'Finir le diagnostic',
    });
    await expect(btn).toBeEnabled({ timeout: 8000 });
    await btn.click();
    await btn.click({ force: true }).catch(() => {});
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();

    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await page.waitForTimeout(1500);
    expect(saveTime, `saveTimeDiag ×${saveTime}`).toBe(1);
    expect(finish, `finish ×${finish}`).toBe(1);
    expect(transition, `transition ×${transition}`).toBe(1);
});

test('error on finish step → transition NOT fired, modal open, status unchanged', async ({
    page,
}) => {
    const s = await seedDiag('D', {
        containPdr: true,
        canRepair: true,
        withComposant: true,
    });
    let transition = 0;
    await page.route('**/graphql', async (route) => {
        const b = route.request().postData() || '';
        if (b.includes('changeStatusPending2')) transition++;
        if (b.includes('tech_startDiagnostic')) {
            // Fail ONLY the finish step (step 2 of the cascade).
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    data: null,
                    errors: [
                        { message: 'Simulated finish failure', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
                    ],
                }),
            });
        } else {
            await route.continue();
        }
    });

    await page.goto(TECH_LIST);
    await openDiag(page, s.idnum);
    await goStep(page, 'Validation');
    await setToggle(page, 'isReparable', true);
    await setToggle(page, 'isPdr', false);
    await goStep(page, 'Résumé');
    const btn = page.locator('button.btn--primary', {
        hasText: 'Finir le diagnostic',
    });
    await btn.click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();

    // Error toast + cascade aborted (transition never fired) + modal still open.
    await expect(page.locator('.p-toast-message-error')).toHaveCount(1, {
        timeout: 12000,
    });
    await page.waitForTimeout(1000);
    expect(transition, 'transition must NOT fire after a failed finish').toBe(0);
    await expect(page.locator('.sav-diag-header')).toBeVisible();
    expect(await dbStatus(s.diId), 'status unchanged').toBe('INDIAGNOSTIC');
});
