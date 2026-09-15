import { test, expect } from '@playwright/test';
import { authFile, tokenFor } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * UI click-through des DEUX nouveaux contrôles retour :
 *  1) Le toggle « Facturer le diagnostic ? » dans le modal Pricing, visible pour
 *     un retour Fixtronix + SANS PDR + réparable en PRICING_DIAG.
 *  2) Le déclencheur d'upload de fichiers sur une DI IRREPARABLE 2C
 *     (retour + non-Fixtronix + non réparable).
 */

const TICKET_LIST = 'http://localhost:4200/tickets/ticket/ticket-list';
const TECH_ID = '6623d4fea953a0ebca67e7db';
const tag = `rui_${Date.now().toString(36)}`;
const priceId = `DI_${tag}_price`;
const priceNum = `RUIP-${tag.toUpperCase()}`;
const irrId = `DI_${tag}_irr`;
const irrNum = `RUII-${tag.toUpperCase()}`;
const fxId = `DI_${tag}_fx`;
const fxNum = `RUIF-${tag.toUpperCase()}`;

test.use({ storageState: authFile('ADMIN_MANAGER') });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    void tokenFor('ADMIN_MANAGER');
    await withDb(async (db) => {
        const now = new Date();
        // 1) Retour erreur CLIENT (non-Fixtronix) + réparable, EN PRICING_DIAG.
        await db.collection('dis').insertOne({
            _id: priceId, _idnum: priceNum, title: 'QA retour pricing toggle',
            status: 'PRICING_DIAG', ignoreCount: 1, can_be_repaired: true,
            contain_pdr: false, isErrorFromFixtronix: false, diagnosticPayant: true,
            // Estimation de création > 0 : c'est elle qui verrouillait le champ
            // prix après Non payant → Payant (champ grisé + prix vide).
            diagnosticEstimate: 200,
            client_id: 'C1', current_roles: ['Admin_Manager'], array_composants: [],
            isDeleted: false, statusUpdatedAt: now, createdAt: now, updatedAt: now,
        });
        await db.collection('logsdis').insertOne({
            _id: `log-${priceId}`, _idDi: priceId, idIgnore: 1,
            can_be_repaired: true, contain_pdr: false, array_composants: [],
            isErrorFromFixtronix: false, createdAt: now, updatedAt: now,
        });
        // 2) Retour NON-Fixtronix + non réparable, IRREPARABLE (cas 2C).
        await db.collection('dis').insertOne({
            _id: irrId, _idnum: irrNum, title: 'QA IRREPARABLE 2C docs',
            status: 'IRREPARABLE', ignoreCount: 1, can_be_repaired: false,
            contain_pdr: false, isErrorFromFixtronix: false,
            client_id: 'C1', current_roles: ['Manager'], array_composants: [],
            isDeleted: false, statusUpdatedAt: now, createdAt: now, updatedAt: now,
        });
        // 3) Retour erreur FIXTRONIX + réparable + AVEC pièces, EN PRICING_DIAG
        //    (règle 2026-09-15 : magasin puis tarification).
        const comps = [{ nameComposant: 'Fusible', quantity: 1 }];
        await db.collection('dis').insertOne({
            _id: fxId, _idnum: fxNum, title: 'QA retour Fixtronix pricing',
            status: 'PRICING_DIAG', ignoreCount: 1, can_be_repaired: true,
            contain_pdr: true, isErrorFromFixtronix: true,
            client_id: 'C1', current_roles: ['Admin_Manager'], array_composants: comps,
            isDeleted: false, statusUpdatedAt: now, createdAt: now, updatedAt: now,
        });
        await db.collection('logsdis').insertOne({
            _id: `log-${fxId}`, _idDi: fxId, idIgnore: 1,
            can_be_repaired: true, contain_pdr: true, array_composants: comps,
            isErrorFromFixtronix: true, createdAt: now, updatedAt: now,
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteMany({ _id: { $in: [priceId, irrId, fxId] } });
        await db.collection('logsdis').deleteMany({ _idDi: { $in: [priceId, irrId, fxId] } });
    });
});

test('1) Pricing modal shows the « Facturer le diagnostic ? » toggle (retour erreur client + sans PDR)', async ({ page }) => {
    await page.goto(TICKET_LIST);
    const row = page.locator('tr', { hasText: priceNum });
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Ligne PRICING_DIAG → seul le bouton « Affecter prix » (pi-dollar) est visible.
    await row.locator('button:has(.pi-dollar)').first().click();
    // Modal Pricing ouvert.
    await expect(page.getByText('Fixer le prix du diagnostic')).toBeVisible({ timeout: 15_000 });
    // Le NOUVEAU toggle doit être présent.
    await expect(page.getByText('Facturer le diagnostic', { exact: false })).toBeVisible({ timeout: 10_000 });
});

test('1b) Non payant → Payant rouvre le prix du diagnostic et « Valider le prix »', async ({ page }) => {
    await page.goto(TICKET_LIST);
    const row = page.locator('tr', { hasText: priceNum });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.locator('button:has(.pi-dollar)').first().click();
    const priceInput = page.locator('#pricing-init-input');
    const toggle = page.locator('.pricing-facturer__toggle');
    const submit = page.locator('button.pricing-submit');
    await expect(priceInput).toBeVisible({ timeout: 15_000 });
    // Retour : pas de verrou sur l'estimation de création.
    await expect(priceInput).toBeEnabled();

    await toggle.click(); // → Non payant
    await expect(priceInput).toBeDisabled();
    // Non payant = rien facturé : la réparation est grisée aussi, et on peut valider.
    await expect(page.locator('#pricing-repair-estimate')).toBeDisabled();
    await expect(submit).toBeEnabled();

    await toggle.click(); // → Payant
    await expect(priceInput).toBeEnabled();

    await priceInput.click();
    await priceInput.press('ControlOrMeta+a');
    await priceInput.pressSequentially('180');
    const repair = page.locator('#pricing-repair-estimate');
    await repair.click();
    await repair.pressSequentially('300');
    await expect(priceInput).toHaveValue(/180/);
    await expect(submit).toBeEnabled();
});

test('1c) Retour FIXTRONIX avec pièces : bascule visible, Non payant grise tout, Payant accepte 0', async ({ page }) => {
    await page.goto(TICKET_LIST);
    const row = page.locator('tr', { hasText: fxNum });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.locator('button:has(.pi-dollar)').first().click();
    const priceInput = page.locator('#pricing-init-input');
    const repair = page.locator('#pricing-repair-estimate');
    const toggle = page.locator('.pricing-facturer__toggle');
    const submit = page.locator('button.pricing-submit');
    await expect(priceInput).toBeVisible({ timeout: 15_000 });
    await expect(toggle).toBeVisible();

    await toggle.click(); // → Non payant
    await expect(priceInput).toBeDisabled();
    await expect(repair).toBeDisabled();
    await expect(submit).toBeEnabled();

    await toggle.click(); // → Payant
    await expect(priceInput).toBeEnabled();
    await expect(repair).toBeEnabled();
    await priceInput.click();
    await priceInput.pressSequentially('0');
    await repair.click();
    await repair.pressSequentially('300');
    await expect(priceInput).toHaveValue(/^0/);
    await expect(submit).toBeEnabled();
});

test('2) IRREPARABLE 2C row exposes a document-upload trigger', async ({ page }) => {
    await page.goto(TICKET_LIST);
    const row = page.locator('tr', { hasText: irrNum });
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Au moins un déclencheur d'upload doit apparaître (paperclip « Fichiers »
    // OU le bouton Approval pi-file) — masqués avant le fix.
    const uploadTriggers = row.locator('button:has(.pi-paperclip), button:has(.pi-file)');
    await expect(uploadTriggers.first()).toBeVisible({ timeout: 10_000 });
});
