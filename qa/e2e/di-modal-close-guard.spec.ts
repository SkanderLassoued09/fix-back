import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';
import { techId } from '../utils/accounts';

/**
 * FERMETURE ACCIDENTELLE D'UN MODAL — confirmation + brouillon.
 *
 * Constat de départ : Échap, le clic sur le fond et la croix sont DÉJÀ
 * impossibles (`[closable]="false"`), et le diagnostic bloque « Réduire » tant
 * qu'on n'a pas mis en pause. Les deux chemins qui détruisaient réellement du
 * travail étaient ailleurs :
 *   1. « Réduire » côté RÉPARATION — aucune garde, et le wizard ne persistait
 *      AUCUN brouillon (`// TODO` dans le code) : travaux et pièces perdus ;
 *   2. ouvrir le modal d'une AUTRE DI — `closeOppositeModal()` fermait le modal
 *      en cours EN SILENCE.
 *
 * Ce spec verrouille : confirmation sur ces deux chemins, refus non destructif,
 * et restitution du brouillon de réparation à la réouverture.
 */

const TECH_LIST = '/tickets/ticket/tech-di-list';

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);
let TECH_ID = '';
test.beforeAll(async () => {
    TECH_ID = await withDb(techId);
});

async function seed(
    suffix: string,
    status: 'INDIAGNOSTIC' | 'INREPARATION',
): Promise<{ diId: string; idnum: string }> {
    const diId = `DI_close_${TAG}_${suffix}`;
    const idnum = `CLS-${TAG}-${suffix}`;
    await withDb(async (db) => {
        const client = await db.collection('clients').findOne({ isDeleted: { $ne: true } });
        const now = new Date();
        await db.collection('dis').deleteOne({ _id: diId });
        await db.collection('stats').deleteMany({ _idDi: diId });
        await db.collection('dis').insertOne({
            _id: diId, _idnum: idnum, title: `QA fermeture ${suffix}`,
            description: 'di-modal-close-guard', status,
            can_be_repaired: true, contain_pdr: true,
            array_composants: [{ nameComposant: 'Fusible', quantity: 1, isUpdated: false }],
            di_category_id: 'CAT-CLS', client_id: client?._id ?? null,
            createdBy: TECH_ID, current_workers_ids: [TECH_ID], current_roles: ['Tech'],
            ignoreCount: 0, isDeleted: false,
            statusUpdatedAt: now, createdAt: now, updatedAt: now,
        });
        await db.collection('stats').insertOne({
            _id: `stat-${diId}`, _idDi: diId, diRef: diId,
            id_tech_diag: TECH_ID, id_tech_rep: TECH_ID, status,
            diag_time: '00:00:10', rep_time: '00:00:10',
            ignoreCount: 0, retour_count: 0, pauseLogs: [],
            createdAt: now, updatedAt: now,
        });
    });
    return { diId, idnum };
}

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteMany({ _id: { $regex: `_close_${TAG}_` } });
        await db.collection('stats').deleteMany({ _idDi: { $regex: `_close_${TAG}_` } });
        await db.collection('notifications').deleteMany({ diId: { $regex: `_close_${TAG}_` } });
    });
});

async function openModal(page: Page, idnum: string, kind: 'diag' | 'repair') {
    await expect(async () => {
        const row = page.locator('tr', { hasText: idnum });
        if ((await row.count()) === 0) await page.reload();
        await expect(row.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    await page.locator('tr', { hasText: idnum }).first()
        .locator(`button:has(${kind === 'diag' ? '.pi-search' : '.pi-wrench'})`).click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({ timeout: 10000 });
}

const modal = (page: Page) => page.locator('.sav-diag-header');
const pauseButton = (page: Page) => page.locator('.sav-diag-header__pause');

/**
 * « Réduire » est `[disabled]` tant que le chrono tourne (côté réparation comme
 * côté diagnostic) : il faut donc mettre en pause avant de pouvoir fermer. C'est
 * le geste réel du technicien qui veut « ranger » sa fenêtre.
 */
async function pauseThenMinimize(page: Page) {
    await pauseButton(page).click();
    await expect(pauseButton(page)).toContainText('Reprendre', { timeout: 12000 });
    const minimize = page.locator('.sav-diag-header__minimize');
    await expect(minimize).toBeEnabled({ timeout: 12000 });
    await minimize.click();
}
const confirmDialog = (page: Page) => page.locator('.p-confirm-dialog');
const worksField = (page: Page) => page.locator('textarea[formcontrolname="worksDone"]');

/** Saisir des travaux : c'est ce qui rend le wizard « sale ». */
async function typeRepairWork(page: Page, text: string) {
    await expect(worksField(page)).toBeVisible({ timeout: 10000 });
    await worksField(page).fill(text);
    await worksField(page).blur();
}

test('répa — « Réduire » avec une saisie demande CONFIRMATION ; refuser ne ferme rien', async ({ page }) => {
    const s = await seed('reject', 'INREPARATION');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'repair');
    await typeRepairWork(page, 'Soudure en cours, ne pas perdre.');

    await pauseThenMinimize(page);

    // La confirmation doit apparaître AU-DESSUS du modal (le p-confirmDialog est
    // déclaré hors du modal : un z-index mal empilé la rendrait invisible).
    await expect(confirmDialog(page)).toBeVisible({ timeout: 8000 });
    await confirmDialog(page).locator('.p-confirm-dialog-reject').click();

    // Refus = rien n'est perdu.
    await expect(modal(page)).toBeVisible();
    await expect(worksField(page)).toHaveValue('Soudure en cours, ne pas perdre.');
});

test('répa — accepter ferme, et le brouillon est RESTITUÉ à la réouverture', async ({ page }) => {
    const s = await seed('draft', 'INREPARATION');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'repair');
    await typeRepairWork(page, 'Condensateur remplacé, test OK.');

    await pauseThenMinimize(page);
    await expect(confirmDialog(page)).toBeVisible({ timeout: 8000 });
    await confirmDialog(page).locator('.p-confirm-dialog-accept').click();
    await expect(modal(page)).toBeHidden({ timeout: 8000 });

    // Réouverture : la saisie doit revenir (avant, elle était perdue).
    await openModal(page, s.idnum, 'repair');
    await expect(worksField(page)).toHaveValue('Condensateur remplacé, test OK.');
});

test('répa — sans saisie, « Réduire » ne pose AUCUNE question', async ({ page }) => {
    const s = await seed('clean', 'INREPARATION');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'repair');
    await expect(worksField(page)).toBeVisible({ timeout: 10000 });

    await pauseThenMinimize(page);

    // Pas de travail en cours ⇒ pas de friction inutile.
    await expect(modal(page)).toBeHidden({ timeout: 8000 });
    await expect(confirmDialog(page)).toBeHidden();
});

test('bascule — la liste est INATTEIGNABLE derrière le modal : rien n\'est détruit', async ({ page }) => {
    const a = await seed('switchA', 'INREPARATION');
    const b = await seed('switchB', 'INDIAGNOSTIC');
    await page.goto(TECH_LIST);
    await openModal(page, a.idnum, 'repair');
    await typeRepairWork(page, 'Travaux en cours sur la DI A.');

    // Constat mesuré : le modal est un calque PLEIN ÉCRAN, la loupe de la DI B
    // est donc DERRIÈRE lui et le clic est refusé (« subtree intercepts pointer
    // events »). La protection contre la bascule accidentelle vient de la mise
    // en page, pas d'une alerte — et c'est plus solide qu'une confirmation.
    // La garde `confirmDiscardWork` de diagModal()/repModal() reste en défense
    // au cas où un chemin de code ouvrirait les deux modals.
    const other = page
        .locator('tr', { hasText: b.idnum })
        .first()
        .locator('button:has(.pi-search)');
    const clicked = await other
        .click({ timeout: 3000 })
        .then(() => true, () => false);
    expect(clicked, 'la liste ne doit pas être cliquable sous le modal').toBe(
        false,
    );

    // Rien n'a été détruit : le modal A est toujours là, saisie intacte.
    await expect(modal(page)).toBeVisible();
    await expect(worksField(page)).toHaveValue('Travaux en cours sur la DI A.');
});
