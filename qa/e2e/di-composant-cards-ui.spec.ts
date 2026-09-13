import { test, expect, Page } from '@playwright/test';
import { authFile } from '../utils/auth';

/**
 * UI end-to-end des CARTES COMPOSANT du modal « Dossier d'intervention ».
 *
 * La DI ne stocke que `{ nameComposant, quantity }` : prix, statut, date
 * d'arrivage, stock et catégorie viennent du CATALOGUE, joint par NOM. Ces
 * tests vérifient la jointure sur des données RÉELLES, avec les pièges qu'elles
 * contiennent : `status_composant` valant littéralement « undefined »,
 * `coming_date` écrite en `Date.prototype.toString()` complet ou « Invalid
 * Date », composants soft-supprimés, et noms absents du catalogue.
 *
 * Rappel d'architecture : la liste vient de `logs[idIgnore === cycle]`, JAMAIS
 * de la racine `di` — « une valeur absente doit rester absente ».
 *
 * LECTURE SEULE — aucune mutation.
 */

const TICKET_LIST = '/tickets/ticket/ticket-list';
const COORDINATOR = '/tickets/ticket/coordinator-di-list';

/** T1231 — cycle 1 : « 817B » (au catalogue) + « 100 ohm » (absent). */
const DI_MIXED = 'DI_SCq0';
/** DI19 — cycle 2 : 3 composants tous SOFT-SUPPRIMÉS du catalogue. */
const DI_SOFT_DELETED = 'DI_RCm5';

async function openModal(page: Page, diId: string) {
    await page.goto(`${TICKET_LIST}?di=${diId}&action=detail`, {
        waitUntil: 'domcontentloaded',
    });
    await expect(
        page,
        'redirigé vers /auth/login → token expiré ?',
    ).not.toHaveURL(/\/auth\/login/);
    const modal = page.locator('.di-info-modal');
    await expect(modal).toBeVisible({ timeout: 25_000 });
    await expect(modal.locator('.di-facts .di-fact').first()).toBeVisible({
        timeout: 20_000,
    });
    return modal;
}

test.describe('ADMIN_MANAGER — ticket-list', () => {
    test.use({ storageState: authFile('ADMIN_MANAGER') });

    test('carte complète : réf., package, catégorie, statut, prix, stock, arrivage', async ({
        page,
    }) => {
        const modal = await openModal(page, DI_MIXED);
        const cards = modal.locator('.di-comp__card');
        await expect(cards).toHaveCount(2);

        const card = cards.filter({ hasText: '817B' });
        await expect(card).toHaveCount(1);
        await expect(card).toContainText('Réf. Cmp76');
        await expect(card).toContainText('vfvfgdfg'); // package (espace de tête rognée)
        await expect(card).toContainText('Optocoupleur'); // catégorie RÉSOLUE depuis l'id
        await expect(card).toContainText('0,500 TND'); // PU achat
        await expect(card).toContainText('1,000 TND'); // PU vente = total ligne (qté 1)
        await expect(card).toContainText('29/01/2026'); // `Date.toString()` héritée

        // Pastille de statut réellement peuplée.
        const pill = card.locator('.di-comp__status');
        await expect(pill).toHaveText('Interne');
        await expect(pill).toHaveAttribute('data-status', 'INTERN');

        // Stock = 1 → « faible » (seuil de réappro 5).
        const stock = card.locator('.di-comp__stock');
        await expect(stock).toContainText('1');
        await expect(stock).toHaveAttribute('data-health', 'low');
    });

    test('nom absent du catalogue : carte dégradée + total partiel annoncé', async ({
        page,
    }) => {
        const modal = await openModal(page, DI_MIXED);

        const orphan = modal
            .locator('.di-comp__card')
            .filter({ hasText: '100 ohm' });
        await expect(orphan).toHaveCount(1);
        await expect(orphan).toHaveClass(/di-comp__card--orphan/);
        await expect(orphan.locator('.di-comp__status')).toHaveText(
            'Hors catalogue',
        );
        await expect(orphan).toContainText('Composant absent du catalogue');

        // Le total ne compte QUE les lignes tarifées, et le dit.
        await expect(modal.locator('.di-comp__total')).toContainText(
            '1,000 TND',
        );
        await expect(modal.locator('.di-comp__note')).toContainText(
            'Total calculé sur 1 ligne(s) sur 2',
        );
    });

    test('aucune donnée brute illisible ne fuit dans la vue', async ({
        page,
    }) => {
        const modal = await openModal(page, DI_SOFT_DELETED);
        const comp = modal.locator('.di-comp');
        await expect(modal.locator('.di-comp__card')).toHaveCount(3);

        // Sérialisations héritées de `coming_date` — jamais affichées telles quelles.
        await expect(comp).not.toContainText('GMT+');
        await expect(comp).not.toContainText('heure normale');
        await expect(comp).not.toContainText('Invalid Date');
        // Sentinelles littérales du catalogue.
        await expect(comp).not.toContainText('undefined');
        await expect(comp).not.toContainText('null');
    });

    test('les composants suivent le CYCLE sélectionné (pas de fuite entre cycles)', async ({
        page,
    }) => {
        const modal = await openModal(page, DI_MIXED);
        await expect(modal.locator('.di-comp__card')).toHaveCount(2);

        // Le flux original n'a pas de dossier de composants : la section doit se
        // VIDER, et surtout ne pas hériter de la liste du cycle de retour.
        const cycle0 = modal
            .locator('button')
            .filter({ hasText: /Flux original/i })
            .first();
        await expect(cycle0).toBeVisible({ timeout: 10_000 });
        await cycle0.click();

        await expect(modal.locator('.di-comp__card')).toHaveCount(0);
        await expect(
            modal.locator('.di-empty', {
                hasText: 'Aucun composant pour ce cycle.',
            }),
        ).toBeVisible();
    });
});

test.describe('COORDINATOR — coordinator-di-list', () => {
    test.use({ storageState: authFile('COORDINATOR') });

    test('le même modal partagé rend les cartes côté coordinatrice', async ({
        page,
    }) => {
        await page.goto(COORDINATOR, { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/auth\/login/);

        const detailBtn = page.locator('button:has(.pi-book)').first();
        await expect(detailBtn).toBeVisible({ timeout: 25_000 });
        await detailBtn.click();

        const modal = page.locator('.di-info-modal');
        await expect(modal).toBeVisible({ timeout: 20_000 });
        // La section Composants est rendue (cartes ou état vide) sous CE host.
        await expect(
            modal.locator('.di-comp, .di-empty').first(),
        ).toBeVisible({ timeout: 15_000 });

        // L'ancien pseudo-tableau Composant/Qté a bien disparu partout.
        await expect(modal.locator('.di-comp__row')).toHaveCount(0);
        await expect(modal.locator('.di-comp__head')).toHaveCount(0);
    });
});
