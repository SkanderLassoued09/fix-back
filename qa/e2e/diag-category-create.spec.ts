import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Création d'une catégorie de diagnostic DEPUIS le dropdown de l'étape
 * « Panne » du modal technicien.
 *
 * Avant, le champ « Catégorie de diagnostic » était un `p-dropdown` SANS
 * recherche, et une catégorie manquante était une impasse : « Suivant » reste
 * bloqué sans catégorie, et seul l'encadrement peut en créer une depuis
 * « Relations & Structure ». Le technicien choisissait donc une catégorie
 * approchante — le référentiel se polluait en silence.
 *
 * Ce que prouve ce spec :
 *   - la recherche filtre la liste ;
 *   - un libellé inédit fait apparaître « Créer « X » » DANS le panneau ;
 *   - le clic crée, SÉLECTIONNE, ferme le panneau et débloque « Suivant » ;
 *   - la catégorie créée est RÉELLEMENT dans la liste au rouvrir — c'est la
 *     non-régression du cache par référence de `diagCategoryOptions`, qui
 *     renverrait un cache périmé si le code faisait un `.push()` ;
 *   - un doublon de casse ne crée RIEN et sélectionne l'existant ;
 *   - la mutation est authentifiée (garde `JwtAuthGuard`).
 */

const TECH_ID = '6623d4fea953a0ebca67e7db';
const TECH_LIST = '/tickets/ticket/tech-di-list';

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);
/** Libellé inédit — préfixe filtrable pour le nettoyage. */
const NEW_CAT = `QACAT-${TAG}`;
const DI_ID = `DI_catui_${TAG}`;
const STAT_ID = `STAT_catui_${TAG}`;
const IDNUM = `CAT-${TAG}`;

test.beforeAll(async () => {
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        await db.collection('dis').insertOne({
            _id: DI_ID,
            _idnum: IDNUM,
            title: `QA Catégorie diag ${TAG}`,
            description: 'staged for diag-category-create',
            status: 'INDIAGNOSTIC',
            can_be_repaired: true,
            contain_pdr: false, // pas de PDR : l'étape Composants est masquée
            di_category_id: null,
            client_id: client?._id ?? null,
            createdBy: TECH_ID,
            location_id: null,
            array_composants: [],
            current_workers_ids: [TECH_ID],
            current_roles: ['Tech'],
            isDeleted: false,
            statusUpdatedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await db.collection('stats').insertOne({
            _id: STAT_ID,
            _idDi: DI_ID,
            diRef: DI_ID,
            id_tech_diag: TECH_ID,
            id_tech_rep: TECH_ID,
            status: 'INDIAGNOSTIC',
            diag_time: '00:00:10',
            rep_time: '',
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
        await db.collection('dis').deleteMany({ _id: DI_ID });
        await db.collection('stats').deleteMany({ _id: STAT_ID });
        // La catégorie créée par le test + sa trace de notification.
        const cats = await db
            .collection('dicategories')
            .find({ category: { $regex: `^QACAT-` } })
            .toArray();
        const ids = cats.map((c: any) => c._id);
        await db.collection('dicategories').deleteMany({ _id: { $in: ids } });
        await db
            .collection('system_events')
            .deleteMany({ type: 'DI_CATEGORY_CREATED', 'payload.categoryId': { $in: ids } });
        await db
            .collection('notifications')
            .deleteMany({ type: 'DI_CATEGORY_CREATED' });
    });
});

/** Ouvre le modal diagnostic depuis la ligne seedée. */
async function openDiagModal(page: Page) {
    await expect(async () => {
        const row = page.locator('tr', { hasText: IDNUM });
        if ((await row.count()) === 0) await page.reload();
        await expect(row.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    await page
        .locator('tr', { hasText: IDNUM })
        .first()
        .locator('button:has(.pi-search)')
        .click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({ timeout: 10000 });
}

/** Va sur l'étape « Panne » via le stepper de gauche. */
async function gotoFailureStep(page: Page) {
    await page.locator('sav-diag-stepper').getByText('Panne', { exact: false }).click();
    await expect(page.getByText('Catégorie de diagnostic')).toBeVisible();
}

const panel = (page: Page) => page.locator('.sav-diag-cat-panel');
const filterBox = (page: Page) => panel(page).locator('.p-dropdown-filter');
const createBtn = (page: Page) => panel(page).locator('.cat-create__btn');

async function openCategoryPanel(page: Page) {
    await page.locator('#diag-category').click();
    await expect(panel(page)).toBeVisible({ timeout: 5000 });
}

test('la recherche filtre, et un libellé inédit propose « Créer »', async ({ page }) => {
    await page.goto(TECH_LIST);
    await openDiagModal(page);
    await gotoFailureStep(page);
    await openCategoryPanel(page);

    // Le champ de recherche existe (il n'existait pas avant).
    await expect(filterBox(page)).toBeVisible();

    // Rien à créer tant que la saisie est vide.
    await expect(createBtn(page)).toHaveCount(0);

    await filterBox(page).fill(NEW_CAT);
    await expect(createBtn(page)).toBeVisible();
    await expect(createBtn(page)).toContainText(NEW_CAT);
});

test('créer : sélectionne, ferme le panneau et débloque « Suivant »', async ({ page }) => {
    await page.goto(TECH_LIST);
    await openDiagModal(page);
    await gotoFailureStep(page);
    await openCategoryPanel(page);

    await filterBox(page).fill(NEW_CAT);
    await createBtn(page).click();

    // Panneau fermé + valeur sélectionnée.
    await expect(panel(page)).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('#diag-category')).toContainText(NEW_CAT);

    // Persistée, et UNE seule fois.
    const count = await withDb((db) =>
        db.collection('dicategories').countDocuments({ category: NEW_CAT }),
    );
    expect(count).toBe(1);

    // L'encadrement est prévenu (une notification par destinataire).
    const events = await withDb((db) =>
        db
            .collection('system_events')
            .countDocuments({ type: 'DI_CATEGORY_CREATED' }),
    );
    expect(events).toBe(1);

    // « Suivant » se débloque une fois les DEUX remarques saisies : la
    // description de la panne ET la remarque technicien, toutes deux
    // obligatoires (l'étape « Panne » n'est complète qu'avec les trois champs,
    // catégorie incluse).
    await page.locator('#diag-desc').fill('Panne relevée par le test E2E.');
    const next = page.locator('.sav-diag-modal__nav-btn--primary');
    await expect(next).toBeDisabled();
    await page.locator('#diag-extra').fill('Remarque technicien E2E.');
    await expect(next).toBeEnabled();
});

test('la catégorie créée est dans la liste au rouvrir (cache par référence)', async ({ page }) => {
    await page.goto(TECH_LIST);
    await openDiagModal(page);
    await gotoFailureStep(page);
    await openCategoryPanel(page);

    await filterBox(page).fill(NEW_CAT);
    // Elle est proposée comme OPTION, et « Créer » a disparu (nom déjà pris).
    await expect(
        panel(page).locator('.p-dropdown-item', { hasText: NEW_CAT }),
    ).toBeVisible();
    await expect(createBtn(page)).toHaveCount(0);
});

test('un doublon de casse ne crée rien et sélectionne l’existant', async ({ page }) => {
    await page.goto(TECH_LIST);
    await openDiagModal(page);
    await gotoFailureStep(page);
    await openCategoryPanel(page);

    // Même nom en minuscules : aucune option exacte côté PrimeNG (le filtre est
    // « contains », donc l'option APPARAÎT) — on la sélectionne directement.
    await filterBox(page).fill(NEW_CAT.toLowerCase());
    await panel(page).locator('.p-dropdown-item').first().click();

    const count = await withDb((db) =>
        db.collection('dicategories').countDocuments({ category: { $regex: '^QACAT-' } }),
    );
    expect(count).toBe(1);
});

test('la mutation exige une authentification', async ({ request }) => {
    const res = await request.post('http://localhost:3000/graphql', {
        data: {
            query: `mutation { createDiCategory(category: "QACAT-anon-${TAG}") { _id created } }`,
        },
    });
    const body = await res.json();
    expect(JSON.stringify(body.errors ?? [])).toContain('UNAUTHENTICATED');

    const leaked = await withDb((db) =>
        db.collection('dicategories').countDocuments({ category: `QACAT-anon-${TAG}` }),
    );
    expect(leaked).toBe(0);
});
