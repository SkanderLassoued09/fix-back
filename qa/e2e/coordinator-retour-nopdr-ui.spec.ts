import { test, expect, Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Retour sans pièces (erreur Fixtronix, PENDING3 + `needsDevisBeforeRepair`) —
 * le devis ne se joint PLUS dans le modal coordinatrice : il se dépose dans
 * « Affectation du prix final » (ticket-list), en mode documents seuls.
 *
 *  1. COORDINATRICE, devis absent : plus de carte « Retour sans pièces » ; le
 *     sélecteur du réparateur est VERROUILLÉ avec la note « En attente du devis ».
 *  2. MANAGER : « Affectation du prix final » s'ouvre sur la DI, sans tarification
 *     ni « Confirmer le prix final » (non facturé).
 *  3. COORDINATRICE, devis déposé : sélecteur déverrouillé, note absente.
 *  4. MANAGER, devis + BC déposés : plus rien à téléverser → aucune modale.
 *
 * Le dépôt réel (Drive) n'est pas rejoué : le devis est posé en base, comme le
 * fait `writeCurrentCycleDoc` sur le miroir DI.
 */

const TICKET_LIST = '/tickets/ticket/ticket-list';
const COORD_LIST = '/tickets/ticket/coordinator-di-list';
const tag = `rnpui_${Date.now().toString(36)}`;
const diId = `DI_${tag}`;
const idnum = `RNPUI-${tag.toUpperCase()}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    await withDb(async (db) => {
        const now = new Date();
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: 'QA retour sans pièces',
            description: 'devis via Affectation du prix final',
            status: 'PENDING3',
            ignoreCount: 1,
            needsDevisBeforeRepair: true,
            isErrorFromFixtronix: true,
            can_be_repaired: true,
            contain_pdr: false,
            array_composants: [],
            current_roles: ['Coordinator'],
            isDeleted: false,
            statusUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteOne({ _id: diId });
    });
});

/** L'overlay (parfois périmé) du dev-server capte les clics. */
async function dropDevServerOverlay(page: Page) {
    await page.evaluate(() =>
        document.getElementById('webpack-dev-server-client-overlay')?.remove(),
    );
}

async function openCoordinatorFlow(page: Page) {
    await page.goto(`${COORD_LIST}?di=${diId}&action=affecter`, {
        waitUntil: 'domcontentloaded',
    });
    await expect(page).not.toHaveURL(/\/auth\/login/);
    await dropDevServerOverlay(page);
    const dialog = page.locator('.cf-dialog');
    await expect(dialog).toBeVisible({ timeout: 25_000 });
    return dialog.locator('.cf-step', {
        has: page.locator('.cf-step__title', { hasText: /^Réparation$/ }),
    });
}

async function openApproval(page: Page) {
    await page.goto(`${TICKET_LIST}?di=${diId}&action=approval`, {
        waitUntil: 'domcontentloaded',
    });
    await expect(page).not.toHaveURL(/\/auth\/login/);
    await dropDevServerOverlay(page);
}

test.describe('devis absent', () => {
    test.describe('coordinatrice', () => {
        test.use({ storageState: authFile('COORDINATOR') });

        test('plus de carte devis ; sélecteur réparateur verrouillé', async ({ page }) => {
            const repair = await openCoordinatorFlow(page);
            await expect(repair).toBeVisible();
            await expect(page.getByText('Retour sans pièces — magasin')).toHaveCount(0);
            await expect(page.locator('.cf-repair-devis')).toHaveCount(0);
            await expect(page.locator('app-pdf-dropzone:visible')).toHaveCount(0);

            await expect(repair.locator('.p-dropdown')).toHaveClass(/p-disabled/);
            await expect(repair.getByText('En attente du devis')).toBeVisible();
        });
    });

    test.describe('manager', () => {
        test.use({ storageState: authFile('MANAGER') });

        test('« Affectation du prix final » en mode documents seuls', async ({ page }) => {
            await openApproval(page);
            const modal = page.locator('.pricing-modal', {
                hasText: 'Affectation du prix final',
            });
            await expect(modal).toBeVisible({ timeout: 25_000 });

            await expect(modal.getByText('Retour sans pièces (erreur Fixtronix)')).toBeVisible();
            await expect(modal.getByText('Déposer le devis')).toBeVisible();
            await expect(modal.locator('.fp-tarif-card')).toHaveCount(0);
            await expect(
                modal.getByRole('button', { name: 'Confirmer le prix final' }),
            ).toHaveCount(0);
            await expect(
                modal.locator('.pricing-modal__footer').getByRole('button', { name: 'Fermer' }),
            ).toBeVisible();
        });
    });
});

test.describe('devis déposé', () => {
    test.beforeAll(async () => {
        await withDb(async (db) => {
            await db
                .collection('dis')
                .updateOne(
                    { _id: diId },
                    { $set: { devis: 'https://drive.google.com/test-devis.pdf' } },
                );
        });
    });

    test.describe('coordinatrice', () => {
        test.use({ storageState: authFile('COORDINATOR') });

        test('sélecteur réparateur déverrouillé', async ({ page }) => {
            const repair = await openCoordinatorFlow(page);
            await expect(repair.locator('.p-dropdown')).toBeVisible();
            await expect(repair.locator('.p-dropdown')).not.toHaveClass(/p-disabled/);
            await expect(repair.getByText('En attente du devis')).toHaveCount(0);
        });
    });

    test.describe('manager, devis + BC', () => {
        test.use({ storageState: authFile('MANAGER') });

        test('plus rien à téléverser : aucune modale', async ({ page }) => {
            await withDb(async (db) => {
                await db
                    .collection('dis')
                    .updateOne(
                        { _id: diId },
                        { $set: { bon_de_commande: 'https://drive.google.com/test-bc.pdf' } },
                    );
            });
            await openApproval(page);
            await expect(
                page.getByText('Plus aucun document à téléverser pour cette DI.'),
            ).toBeVisible({ timeout: 25_000 });
            await expect(page.locator('.pricing-modal:visible')).toHaveCount(0);
        });
    });
});
