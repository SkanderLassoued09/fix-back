import { test, expect } from '@playwright/test';
import { authFile, tokenFor } from '../utils/auth';
import { withDb } from '../utils/mongo';
import { techId } from '../utils/accounts';
import { gqlPost } from '../utils/graphql';

/**
 * DI IRRÉPARABLE — « Affectation des Fichiers » ouverte sur TOUTE DI irréparable
 * (y compris cycle 0 et erreur Fixtronix), avec les 4 documents, et UN dépôt
 * par document.
 *
 *  - le trombone apparaît sur la ligne ;
 *  - 4 emplacements, dans l'ordre de la chaîne (Devis, BC, BL, Facture) ;
 *  - un emplacement déjà rempli (BL seedé) est fermé, les autres restent ouverts ;
 *  - BC verrouillé tant qu'il n'y a pas de devis, rouvert dès qu'un devis est
 *    sélectionné ;
 *  - le back refuse un second dépôt (`DOC_ALREADY_UPLOADED`) et la DI reste
 *    IRREPARABLE.
 *
 * Aucun dépôt Drive réel : la garde back échoue AVANT l'upload, et côté UI on
 * s'arrête à la sélection (rien n'est enregistré).
 */

const TICKET_LIST = '/tickets/ticket/ticket-list';
let TECH_ID = '';
const tag = `irrf_${Date.now().toString(36)}`;
const diId = `DI_${tag}`;
const idnum = `IRF-${tag.toUpperCase()}`;
const BL_URL = 'https://drive.google.com/test-bl-irreparable.pdf';

test.use({ storageState: authFile('ADMIN_MANAGER') });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    TECH_ID = await withDb(techId);
    await withDb(async (db) => {
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: 'QA IRREPARABLE fichiers',
            description: 'irréparable, cycle 0, erreur Fixtronix',
            status: 'IRREPARABLE',
            can_be_repaired: false,
            contain_pdr: false,
            // Hors de l'ancienne règle (retour + erreur non Fixtronix) : prouve
            // que TOUTE DI irréparable est éligible.
            ignoreCount: 0,
            isErrorFromFixtronix: true,
            createdBy: TECH_ID,
            current_workers_ids: [TECH_ID],
            current_roles: ['Manager'],
            isDeleted: false,
            array_composants: [],
            bon_de_livraison: BL_URL,
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

const cell = (page: any, tagText: string) =>
    page.locator('.af-upload-cell', {
        has: page.locator('.af-tag', { hasText: new RegExp(`^\\s*${tagText}\\s*$`) }),
    });

test('4 emplacements, BL rempli fermé, BC rouvert par un devis sélectionné', async ({
    page,
}) => {
    await page.goto(TICKET_LIST);
    await page.evaluate(() =>
        document.getElementById('webpack-dev-server-client-overlay')?.remove(),
    );
    const row = page.locator('tr', { hasText: idnum });
    await expect(row).toBeVisible({ timeout: 25_000 });

    await row.locator('button:has(.pi-paperclip)').click();
    await expect(page.locator('.af-modal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.af-modal__subtitle')).toContainText(idnum);

    // Les 4 documents, dans l'ordre de la chaîne d'enregistrement.
    await expect(page.locator('.af-upload-cell')).toHaveCount(4);
    await expect(page.locator('.af-upload-cell .af-tag')).toHaveText([
        'DEV',
        'BC',
        'BL',
        'FAC',
    ]);

    // BL déjà là → dépôt fermé.
    const bl = cell(page, 'BL');
    await expect(bl.locator('.af-dropzone')).toHaveClass(/af-dropzone--disabled/);
    await expect(bl.locator('input[type="file"]')).toBeDisabled();
    await expect(bl.locator('.af-dropzone__title')).toContainText('PDF chargé');

    // Facture et Devis ouverts.
    await expect(cell(page, 'FAC').locator('input[type="file"]')).toBeEnabled();
    const devis = cell(page, 'DEV');
    await expect(devis.locator('input[type="file"]')).toBeEnabled();

    // BC verrouillé sans devis…
    const bc = cell(page, 'BC');
    await expect(bc.locator('.af-dropzone--locked')).toBeVisible();

    // …rouvert dès qu'un devis est sélectionné (rien n'est enregistré).
    await devis.locator('input[type="file"]').setInputFiles({
        name: 'devis.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
    });
    await expect(devis.locator('.af-file-card')).toBeVisible();
    await expect(bc.locator('.af-dropzone--locked')).toHaveCount(0);
    await expect(bc.locator('input[type="file"]')).toBeEnabled();
    await expect(page.locator('.af-modal__counter')).toContainText('1');

    await page.locator('.af-modal__close').click();
    await expect(page.locator('.af-modal')).not.toBeVisible({ timeout: 5_000 });
});

test('le back refuse un second dépôt et la DI reste IRREPARABLE', async ({
    request,
}) => {
    const res = await gqlPost(
        request,
        `mutation { addBl(_id: "${diId}", pdf: "data:application/pdf;base64,JVBERi0xLjQK") { _id } }`,
        tokenFor('ADMIN_MANAGER'),
    );
    expect(res.errors?.[0]?.extensions?.code).toBe('DOC_ALREADY_UPLOADED');

    const di = await withDb((db) => db.collection('dis').findOne({ _id: diId } as any));
    expect(di?.status).toBe('IRREPARABLE');
    expect(di?.bon_de_livraison).toBe(BL_URL);
});
