import { test, expect } from '@playwright/test';
import { authFile, tokenFor } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * UI smoke test for the redesigned "Affectation des Fichiers" modal in
 * /tickets/ticket/ticket-list. The modal is the existing `filsFinished`
 * dialog, body redesigned to design/image.png — we assert the new chrome
 * (header, 4 status cards, upload grid, footer counter) renders against a
 * seeded FINISHED DI.
 */

const TICKET_LIST = '/tickets/ticket/ticket-list';
const TECH_ID = '69fb49a8fbdfcb7ca81bed0e';
const tag = `af_${Date.now().toString(36)}`;
const diId = `DI_${tag}`;
const idnum = `AF-${tag.toUpperCase()}`;

test.use({ storageState: authFile('ADMIN_MANAGER') });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    void tokenFor('ADMIN_MANAGER');
    await withDb(async (db) => {
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: 'QA Affectation Fichiers',
            description: 'redesigned modal smoke',
            status: 'FINISHED',
            can_be_repaired: true,
            contain_pdr: false,
            createdBy: TECH_ID,
            current_workers_ids: [TECH_ID],
            current_roles: ['Manager'],
            isDeleted: false,
            array_composants: [],
            // 2 docs available, 2 missing — exercises both card states.
            bon_de_commande: 'https://drive.google.com/test-bc.pdf',
            devis: 'https://drive.google.com/test-devis.pdf',
            statusUpdatedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteOne({ _id: diId });
    });
});

test('opens redesigned Affectation modal + shows the 4 status cards', async ({
    page,
}) => {
    await page.goto(TICKET_LIST);
    const row = page.locator('tr', { hasText: idnum });
    await expect(row).toBeVisible({ timeout: 25_000 });

    // The FINISHED row exposes the paperclip "Fichiers" button.
    await row.locator('button:has(.pi-paperclip)').click();

    // Redesigned chrome.
    await expect(page.locator('.af-modal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.af-modal__title')).toHaveText(
        'Affectation des Fichiers',
    );

    // Header subtitle exposes the DI code + lecture-seule context.
    await expect(page.locator('.af-modal__subtitle')).toContainText(idnum);

    // 4 status cards = BC + BL + Facture + Devis.
    await expect(page.locator('.af-status-card')).toHaveCount(4);

    // 2 docs available (BC + Devis) → 2 green dots ; 2 missing.
    await expect(page.locator('.af-status-card__dot--ok')).toHaveCount(2);
    await expect(page.locator('.af-status-card--missing')).toHaveCount(2);
    await expect(page.locator('.af-count-pill')).toHaveText('2');

    // Upload grid renders 2 cells (BL + Facture), each with a dropzone.
    await expect(page.locator('.af-upload-cell')).toHaveCount(2);
    await expect(page.locator('.af-dropzone')).toHaveCount(2);

    // Footer counter starts at "Aucun fichier en attente." (no pending file).
    await expect(page.locator('.af-modal__counter')).toContainText(
        'Aucun fichier en attente',
    );

    // Close via the footer button.
    await page.getByRole('button', { name: 'Fermer' }).last().click();
    await expect(page.locator('.af-modal')).not.toBeVisible({
        timeout: 5_000,
    });
});
