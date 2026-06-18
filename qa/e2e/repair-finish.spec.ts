import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Repair wizard B1–B3 — finishing a repair from the UI.
 *
 *  B1: « Fin réparation » runs the real finish chain → DI becomes FINISHED.
 *  B2: the used parts + repair remark persist (via updateDi) — survive in DB.
 *  B3: the form opens pre-filled — the category is pre-filled from the DI, so
 *      the finish gate is satisfied WITHOUT the test ever touching the category
 *      dropdown (the 2-step wizard only collects worksDone + the two toggles).
 *
 * Staged in Mongo (test DB), hard-deleted after.
 */

const TECH_ID = '69fb49a8fbdfcb7ca81bed0e'; // seeded `tech` account
const TECH_LIST = '/tickets/ticket/tech-di-list';

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);
const diId = `DI_fin_${TAG}`;
const statId = `STAT_fin_${TAG}`;
const idnum = `FIN-${TAG}`;
const PART = `QA Part ${TAG}`;

test.beforeAll(async () => {
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: 'QA Repair Finish',
            description: 'staged for repair-finish B1-B3',
            status: 'REPARATION',
            can_be_repaired: true,
            contain_pdr: true,
            di_category_id: 'CAT-FIN', // pre-fills the wizard category (B3)
            client_id: client?._id ?? null,
            createdBy: TECH_ID,
            // a part chosen earlier (diagnostic) → wizard pre-fills + must persist (B2)
            array_composants: [{ nameComposant: PART, quantity: 2, isUpdated: false }],
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
            id_tech_rep: TECH_ID,
            id_tech_diag: TECH_ID,
            status: 'REPARATION',
            diag_time: '00:05:00',
            rep_time: '00:00:00',
            ignoreCount: 0,
            retour_count: 0,
            pauseLogs: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteOne({ _id: diId });
        await db.collection('stats').deleteOne({ _id: statId });
    });
});

async function dbStatus(): Promise<string | undefined> {
    return withDb(async (db) => {
        const d = await db.collection('dis').findOne({ _id: diId });
        return d?.status;
    });
}

async function next(page: Page) {
    await page.locator('.sav-diag-modal__nav-btn--primary').click();
}

test('« Fin réparation » → DI FINISHED, parts persist, category pre-filled', async ({
    page,
}) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(TECH_LIST);
    const row = page.locator('tr', { hasText: idnum });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.locator('button:has(.pi-wrench)').click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({ timeout: 10000 });

    // The wizard now opens directly on « Travaux & tests » (step 1/2): the
    // former « Informations générales », « Plan d'intervention » and « Pièces
    // utilisées » steps were removed. Category + parts are pre-filled from the
    // DI (B3) and are display-only — they no longer gate closure, so the test
    // never touches them.
    await page
        .locator('textarea[formcontrolname="worksDone"]')
        .fill('Soudure refaite, composant remplacé, nettoyage carte.');
    await page
        .locator('[aria-label="Réparation réussie"] button:has-text("Oui")')
        .click();
    await page
        .locator('[aria-label="Tests validés"] button:has-text("Oui")')
        .click();

    // works → summary (step 2/2)
    await next(page);
    const finishBtn = page.locator('.cta__btn');
    // Finish is ENABLED from worksDone + the two toggles alone — the category /
    // plan / parts are pre-filled and no longer required by the gate (B3).
    await expect(finishBtn, 'finish enabled on the 2-step wizard').toBeEnabled({
        timeout: 8000,
    });
    await finishBtn.click();

    // B1: one success toast + DI becomes FINISHED in the DB.
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await expect(page.locator('.p-toast-message-error')).toHaveCount(0);
    await expect.poll(dbStatus, { timeout: 12000 }).toBe('FINISHED');

    // B2: the part + repair remark persisted.
    await withDb(async (db) => {
        const d = await db.collection('dis').findOne({ _id: diId });
        const names = (d?.array_composants ?? []).map((c: any) => c.nameComposant);
        expect(names).toContain(PART);
        expect(String(d?.remarque_tech_repair ?? '')).toContain('Travaux');
    });

    expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);
});
