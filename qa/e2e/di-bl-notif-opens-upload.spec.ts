import { test, expect } from '@playwright/test';
import { authFile, userIdFor } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * LE chemin que personne ne testait : cliquer la notification « BL à téléverser »
 * (`DI_DOC_BL_PENDING`) dans la cloche doit ouvrir DIRECTEMENT la modale
 * « Affectation des Fichiers ».
 *
 * On le joue en COORDINATRICE, parce que c'est le rôle que le bug cassait — et
 * c'est la destinataire citée en PREMIER par les deux sites d'émission
 * (`di.service.ts:2796` et `:5272`).
 *
 * Deux régressions sont verrouillées ici :
 *
 *  1. PAGINATION. Le deep-link naviguait vers `ticket-list?di=…&action=affectation`
 *     et `DeepLinkConsumer` cherchait la ligne dans les DI DÉJÀ CHARGÉES. La liste
 *     n'en charge que 10 (les plus récentes) alors qu'une DI en `WAITING_BL` est
 *     par construction ancienne → ligne introuvable, repli sur la modale DÉTAIL
 *     après 3,2 s. La DI seedée ici est datée d'il y a 30 jours exprès.
 *
 *  2. GUARD DE ROUTE. `routeAccessGuard` refuse `ticket-list` à `COORDIANTOR` et
 *     la renvoyait sur sa page d'accueil EN PERDANT la query string : clic mort.
 *     D'où l'assertion sur l'URL — la modale s'ouvre SUR PLACE, sans navigation.
 */

const COORD_LIST = '/tickets/ticket/coordinator-di-list';
const tag = `blnotif_${Date.now().toString(36)}`;

/** DI éligible : en attente du BL. */
const diId = `DI_${tag}`;
const idnum = `BLN-${tag.toUpperCase()}`;
/** DI dont le BL est DÉJÀ arrivé : `FINISHED` reste un statut ÉLIGIBLE (on peut
 *  joindre des pièces a posteriori), donc la modale s'ouvre — mais tout est déjà
 *  « Disponible » et il n'y a rien à enregistrer. */
const staleDiId = `DI_${tag}_stale`;
const staleIdnum = `BLS-${tag.toUpperCase()}`;
/** DI NON éligible : `IRREPARABLE` sans retour → aucune pièce à joindre, la
 *  notification doit retomber sur le dossier (règle stricte `canAffectFiles`). */
const inelDiId = `DI_${tag}_inel`;
const inelIdnum = `BLI-${tag.toUpperCase()}`;

/** Destinataire des notifications = l'utilisateur dont la session est rejouée. */
const COORD_ID = userIdFor('COORDINATOR');

test.use({ storageState: authFile('COORDINATOR') });
test.describe.configure({ mode: 'serial' });

/** Une DI « ancienne » : 30 j, donc JAMAIS dans les 10 dernières créées. */
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 3600 * 1000);

test.beforeAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').insertMany([
            {
                _id: diId,
                _idnum: idnum,
                title: 'QA BL notif → upload',
                description: 'le BL est attendu',
                status: 'WAITING_BL',
                can_be_repaired: true,
                contain_pdr: false,
                isDeleted: false,
                array_composants: [],
                current_roles: ['Coordinator'],
                bon_de_commande: 'https://drive.google.com/test-bc.pdf',
                devis: 'https://drive.google.com/test-devis.pdf',
                statusUpdatedAt: THIRTY_DAYS_AGO,
                createdAt: THIRTY_DAYS_AGO,
                updatedAt: THIRTY_DAYS_AGO,
            },
            {
                _id: staleDiId,
                _idnum: staleIdnum,
                title: 'QA BL notif périmée',
                description: 'BL et facture déjà là',
                status: 'FINISHED',
                can_be_repaired: true,
                contain_pdr: false,
                isDeleted: false,
                array_composants: [],
                current_roles: ['Coordinator'],
                bon_de_commande: 'https://drive.google.com/test-bc.pdf',
                devis: 'https://drive.google.com/test-devis.pdf',
                bon_de_livraison: 'https://drive.google.com/test-bl.pdf',
                facture: 'https://drive.google.com/test-fac.pdf',
                statusUpdatedAt: THIRTY_DAYS_AGO,
                createdAt: THIRTY_DAYS_AGO,
                updatedAt: THIRTY_DAYS_AGO,
            },
            {
                _id: inelDiId,
                _idnum: inelIdnum,
                title: 'QA BL notif non éligible',
                description: 'irréparable sans retour',
                status: 'IRREPARABLE',
                can_be_repaired: false,
                contain_pdr: false,
                isDeleted: false,
                array_composants: [],
                current_roles: ['Coordinator'],
                // Pas de retour (`ignoreCount` 0) → rien à joindre.
                ignoreCount: 0,
                statusUpdatedAt: THIRTY_DAYS_AGO,
                createdAt: THIRTY_DAYS_AGO,
                updatedAt: THIRTY_DAYS_AGO,
            },
        ]);
        await db.collection('notifications').insertMany([
            {
                eventId: `evt_${tag}`,
                userId: COORD_ID,
                readAt: null,
                type: 'DI_DOC_BL_PENDING',
                diId,
                message: `Bon de livraison à téléverser (${idnum})`,
                createdAt: new Date(),
            },
            {
                eventId: `evt_${tag}_stale`,
                userId: COORD_ID,
                readAt: null,
                type: 'DI_DOC_BL_PENDING',
                diId: staleDiId,
                message: `Bon de livraison à téléverser (${staleIdnum})`,
                createdAt: new Date(),
            },
            {
                eventId: `evt_${tag}_inel`,
                userId: COORD_ID,
                readAt: null,
                type: 'DI_DOC_BL_PENDING',
                diId: inelDiId,
                message: `Bon de livraison à téléverser (${inelIdnum})`,
                createdAt: new Date(),
            },
        ]);
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db
            .collection('dis')
            .deleteMany({ _id: { $in: [diId, staleDiId, inelDiId] } });
        await db.collection('notifications').deleteMany({
            eventId: {
                $in: [`evt_${tag}`, `evt_${tag}_stale`, `evt_${tag}_inel`],
            },
        });
    });
});

test('la notification BL ouvre la modale de téléversement SUR PLACE (coordinatrice)', async ({
    page,
}) => {
    await page.goto(COORD_LIST);
    await expect(page.locator('.topbar-bell__btn')).toBeVisible();

    // La liste de la cloche n'est chargée QU'À l'ouverture → cliquer d'abord.
    await page.locator('.topbar-bell__btn').click();
    const item = page.locator('.topbar-bell__item', { hasText: idnum });
    await expect(item).toBeVisible();
    await item.click();

    // La modale d'UPLOAD s'ouvre — pas la modale détail.
    await expect(page.locator('.af-modal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.af-modal__title')).toContainText(
        'Affectation des Fichiers',
    );
    await expect(page.locator('.af-modal__subtitle')).toContainText(idnum);

    // Les 2 emplacements de dépôt sont là (BL + Facture).
    await expect(page.locator('.af-upload-cell')).toHaveCount(2);

    // ── L'assertion qui verrouille le bug du guard ──────────────────────────
    // Aucune navigation : on est TOUJOURS sur la page coordination, et il ne
    // reste aucun `?di=&action=` dans l'URL.
    expect(page.url()).toContain('coordinator-di-list');
    expect(page.url()).not.toContain('ticket-list');
    expect(page.url()).not.toContain('action=');
});

test('DI déjà complète : la modale s\'ouvre mais il n\'y a rien à enregistrer', async ({
    page,
}) => {
    await page.goto(COORD_LIST);
    await page.locator('.topbar-bell__btn').click();
    const item = page.locator('.topbar-bell__item', { hasText: staleIdnum });
    await expect(item).toBeVisible();
    await item.click();

    // `FINISHED` reste éligible (pièces jointes a posteriori) → la modale s'ouvre.
    await expect(page.locator('.af-modal')).toBeVisible({ timeout: 10_000 });
    // Les 4 documents sont là → 4 pastilles vertes, aucune carte « Manquant ».
    await expect(page.locator('.af-status-card__dot--ok')).toHaveCount(4);
    await expect(page.locator('.af-status-card--missing')).toHaveCount(0);
    // Rien en attente → le bouton « Enregistrer » reste inactif.
    await expect(page.locator('.af-modal__counter')).toContainText(
        'Aucun nouveau fichier',
    );
    await expect(
        page.locator('.af-btn--save button, button.af-btn--save').first(),
    ).toBeDisabled();
});

test('DI non éligible : la notification retombe sur le dossier, pas sur une modale vide', async ({
    page,
}) => {
    await page.goto(COORD_LIST);
    await page.locator('.topbar-bell__btn').click();
    const item = page.locator('.topbar-bell__item', { hasText: inelIdnum });
    await expect(item).toBeVisible();
    await item.click();

    // `IRREPARABLE` sans retour → rien à téléverser : pas de modale d'upload…
    await expect(page.locator('app-di-info-modal .p-dialog')).toBeVisible({
        timeout: 10_000,
    });
    // …et on ne laisse PAS l'utilisateur devant une modale vide.
    await expect(page.locator('.af-modal')).toHaveCount(0);
});
