import { test, expect } from '@playwright/test';
import { authFile, userIdFor } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Notifications de DEVIS / BC : le clic ouvre DIRECTEMENT la modale où ces
 * documents se téléversent — « Approval (devis/BC) » de `ticket-list`
 * (`negocite1Modal`, titre « Affectation du prix final ») — mais SEULEMENT pour
 * qui peut les téléverser, et seulement si la DI les attend encore. Sinon RIEN ne
 * s'ouvre (règle produit du 2026-09-14).
 *
 *  1. MANAGER + « en attente de devis » (`DI_NEGOTIATION1`) → la modale s'ouvre,
 *     alors que la DI (30 jours) n'est PAS parmi les 10 lignes chargées.
 *  2. MANAGER + notification périmée (BC arrivé, DI en `PENDING3`) → un avis,
 *     aucune modale.
 *  3. COORDINATRICE + même notification → rien : elle n'a pas `ticket-list`,
 *     donc pas la modale ; ni navigation, ni dossier.
 */

const TICKET_LIST = '/tickets/ticket/ticket-list';
const COORD_LIST = '/tickets/ticket/coordinator-di-list';
const tag = `devisnotif_${Date.now().toString(36)}`;

/** DI en attente de devis. */
const diId = `DI_${tag}`;
const idnum = `DVN-${tag.toUpperCase()}`;
/** DI dont le BC est déjà arrivé : partie en attente de réparation. */
const staleDiId = `DI_${tag}_stale`;
const staleIdnum = `DVS-${tag.toUpperCase()}`;

const MANAGER_ID = userIdFor('MANAGER');
const COORD_ID = userIdFor('COORDINATOR');

/** Une DI « ancienne » : 30 j, donc JAMAIS dans les 10 dernières créées. */
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 3600 * 1000);

const baseDi = {
    can_be_repaired: true,
    contain_pdr: false,
    isDeleted: false,
    array_composants: [],
    ignoreCount: 0,
    statusUpdatedAt: THIRTY_DAYS_AGO,
    createdAt: THIRTY_DAYS_AGO,
    updatedAt: THIRTY_DAYS_AGO,
};

const notif = (suffix: string, userId: string, type: string, di: string, message: string) => ({
    eventId: `evt_${tag}_${suffix}`,
    userId,
    readAt: null,
    type,
    diId: di,
    message,
    createdAt: new Date(),
});

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').insertMany([
            {
                ...baseDi,
                _id: diId,
                _idnum: idnum,
                title: 'QA devis attendu',
                description: 'le devis est attendu',
                status: 'WAITING_DEVIS',
                current_roles: ['Manager'],
            },
            {
                ...baseDi,
                _id: staleDiId,
                _idnum: staleIdnum,
                title: 'QA notification devis périmée',
                description: 'devis et BC déjà là',
                status: 'PENDING3',
                current_roles: ['Coordinator'],
                devis: 'https://drive.google.com/test-devis.pdf',
                bon_de_commande: 'https://drive.google.com/test-bc.pdf',
            },
        ]);
        await db.collection('notifications').insertMany([
            notif('mgr', MANAGER_ID, 'DI_NEGOTIATION1', diId, `DI ${idnum} en attente de devis`),
            notif(
                'mgr_stale',
                MANAGER_ID,
                'DI_DOC_DEVIS',
                staleDiId,
                `DI ${staleIdnum} — devis ajouté (à vérifier), en attente de BC`,
            ),
            notif('coord', COORD_ID, 'DI_NEGOTIATION1', diId, `DI ${idnum} en attente de devis`),
        ]);
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteMany({ _id: { $in: [diId, staleDiId] } });
        await db.collection('notifications').deleteMany({
            eventId: { $regex: `^evt_${tag}_` },
        });
    });
});

test.describe('manager (peut téléverser devis / BC)', () => {
    test.use({ storageState: authFile('MANAGER') });

    test('« en attente de devis » ouvre « Approval (devis/BC) »', async ({ page }) => {
        await page.goto(TICKET_LIST);
        await page.locator('.topbar-bell__btn').click();
        const item = page.locator('.topbar-bell__item', { hasText: idnum });
        await expect(item).toBeVisible();
        await item.click();

        await expect(
            page.locator('.pricing-modal__title', { hasText: 'Affectation du prix final' }),
        ).toBeVisible({ timeout: 10_000 });
        // L'URL est nettoyée : pas de ré-ouverture au rafraîchissement.
        await expect(page).not.toHaveURL(/action=/);
    });

    test('notification périmée (BC déjà arrivé) : un avis, aucune modale', async ({ page }) => {
        await page.goto(TICKET_LIST);
        await page.locator('.topbar-bell__btn').click();
        const item = page.locator('.topbar-bell__item', { hasText: staleIdnum });
        await expect(item).toBeVisible();
        await item.click();

        await expect(
            page.getByText('Plus aucun document à téléverser pour cette DI.'),
        ).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('.pricing-modal:visible')).toHaveCount(0);
        await expect(page.locator('app-di-info-modal .p-dialog')).toHaveCount(0);
    });
});

test.describe('coordinatrice (ne peut pas téléverser devis / BC)', () => {
    test.use({ storageState: authFile('COORDINATOR') });

    test('« en attente de devis » : rien ne s’ouvre, aucune navigation', async ({ page }) => {
        await page.goto(COORD_LIST);
        await page.locator('.topbar-bell__btn').click();
        const item = page.locator('.topbar-bell__item', { hasText: idnum });
        await expect(item).toBeVisible();
        await item.click();

        // Laisse le temps à une éventuelle navigation / ouverture de se produire.
        await page.waitForTimeout(2_000);
        expect(page.url()).toContain('coordinator-di-list');
        expect(page.url()).not.toContain('action=');
        await expect(page.locator('.pricing-modal:visible')).toHaveCount(0);
        await expect(page.locator('app-di-info-modal .p-dialog')).toHaveCount(0);
        await expect(page.locator('.af-modal')).toHaveCount(0);
    });
});
