import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';
import { techId } from '../utils/accounts';

/**
 * RETOUR — le modal de diagnostic s'ouvre VIERGE, l'historique en lecture seule.
 *
 * Bug constaté : un retour s'ouvrait avec les composants, la remarque et la
 * catégorie du cycle PRÉCÉDENT. Cause : `diagModal()` choisissait la ligne de
 * cycle via `this.ignoreCount` AVANT de l'avoir renseigné — au premier
 * ouverture après chargement il valait 0, donc la ligne du flux original.
 *
 * Les deux cas passent par un chargement de page NEUF : c'est le chemin qui
 * cassait (aucun modal ouvert auparavant dans la session).
 *
 *   A — nouveau retour (ligne du cycle 1 vierge) : 0 composant, champs vides,
 *       diagnostic du flux original affiché dans « Diagnostics précédents ».
 *   B — retour en pause (le tech a déjà saisi le cycle 1) : on retrouve SA
 *       saisie, jamais celle du cycle 0, et la remarque composée est
 *       redécoupée en description + remarque technicien.
 */

const TECH_LIST = '/tickets/ticket/tech-di-list';
const TAG = Date.now().toString(36);

let TECH_ID = '';
let CATEGORY: { _id: string; category: string } = { _id: '', category: '' };

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    TECH_ID = await withDb(techId);
    // Catégorie RÉELLE : une valeur inventée ne correspond à aucune option et
    // ne prouverait rien sur le libellé affiché.
    CATEGORY = await withDb(async (db) => {
        const c = await db
            .collection('dicategories')
            .findOne({ isDeleted: { $ne: true } });
        return { _id: String(c?._id ?? ''), category: String(c?.category ?? '') };
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        const re = { $regex: `_rblank_${TAG}_` };
        await db.collection('dis').deleteMany({ _id: re });
        await db.collection('stats').deleteMany({ _idDi: re });
        await db.collection('logsdis').deleteMany({ _idDi: re });
        await db.collection('notifications').deleteMany({ diId: re });
    });
});

type Cycle1 = {
    contain_pdr?: boolean;
    array_composants?: Array<{ nameComposant: string; quantity: number }>;
    remarque_tech_diagnostic?: string;
    di_category_id?: string;
};

/**
 * Retour 1 assigné au tech. Cycle 0 = diagnostic d'origine COMPLET (PDR +
 * 2 composants). Cycle 1 = ce que `openRetourCycle` pose (vierge), éventuellement
 * complété par une saisie en pause. La DI (miroir) reflète le cycle 1, comme
 * après `RETOUR_CYCLE_RESET`.
 */
async function seedRetour(suffix: string, cycle1: Cycle1 = {}) {
    const diId = `DI_rblank_${TAG}_${suffix}`;
    const idnum = `RBLK-${TAG}-${suffix}`.toUpperCase();
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        const now = new Date();
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: `QA retour vierge ${suffix}`,
            description: 'retour renvoyé au diagnostic',
            status: 'INDIAGNOSTIC',
            ignoreCount: 1,
            can_be_repaired: null,
            contain_pdr: cycle1.contain_pdr ?? false,
            array_composants: cycle1.array_composants ?? [],
            remarque_tech_diagnostic: cycle1.remarque_tech_diagnostic ?? null,
            client_id: client?._id ?? null,
            createdBy: TECH_ID,
            current_workers_ids: [TECH_ID],
            current_roles: ['Tech'],
            isDeleted: false,
            statusUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
        });
        await db.collection('stats').insertOne({
            _id: `stat-${diId}`,
            _idDi: diId,
            diRef: diId,
            id_tech_diag: TECH_ID,
            id_tech_rep: TECH_ID,
            status: 'INDIAGNOSTIC',
            diag_time: '00:00:00',
            rep_time: '',
            ignoreCount: 1,
            retour_count: 1,
            pauseLogs: [],
            createdAt: now,
            updatedAt: now,
        });
        await db.collection('logsdis').insertMany([
            {
                _id: `log0-${diId}`,
                _idDi: diId,
                idIgnore: 0,
                can_be_repaired: true,
                contain_pdr: true,
                isErrorFromFixtronix: null,
                array_composants: [
                    { nameComposant: 'QA-R0-Condensateur', quantity: 2 },
                    { nameComposant: 'QA-R0-Transistor', quantity: 1 },
                ],
                remarque_tech_diagnostic:
                    'Panne origine R0\n\nRemarque technicien :\nRemarque origine R0',
                remarque_tech_repair: 'Réparation origine R0',
                di_category_id: CATEGORY._id,
                closedAt: now,
                createdAt: now,
                updatedAt: now,
            },
            {
                _id: `log1-${diId}`,
                _idDi: diId,
                idIgnore: 1,
                openedAt: now,
                retourReason: 'panne revenue',
                retourDate: now,
                ...cycle1,
                createdAt: now,
                updatedAt: now,
            },
        ]);
    });
    return { diId, idnum };
}

async function openDiagFresh(page: Page, idnum: string) {
    await page.goto(TECH_LIST);
    await page.evaluate(() =>
        document.getElementById('webpack-dev-server-client-overlay')?.remove(),
    );
    await expect(async () => {
        const row = page.locator('tr', { hasText: idnum });
        if ((await row.count()) === 0) await page.reload();
        await expect(row.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    await page
        .locator('tr', { hasText: idnum })
        .first()
        .locator('button:has(.pi-search)')
        .click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({
        timeout: 10000,
    });
}

async function goStep(page: Page, label: string) {
    await page.locator('.sav-stepper__btn', { hasText: label }).click();
}

test('A — nouveau retour : 0 composant, champs vides, flux original en lecture seule', async ({
    page,
}) => {
    const s = await seedRetour('A');
    await openDiagFresh(page, s.idnum);

    // Validation : les bascules d'un diagnostic NEUF, pas le verdict du cycle 0
    // (qui disait PDR = Oui). La ligne de cycle vierge vaut `contain_pdr: false`
    // (défaut du schéma `logsdis`), exactement comme un flux original neuf.
    const pdr = page.locator('input[formcontrolname="isPdr"]');
    await goStep(page, 'Validation');
    await expect(pdr).not.toBeChecked({ timeout: 8000 });
    await expect(
        page.locator('input[formcontrolname="isReparable"]'),
    ).toBeChecked();
    await expect(
        page.locator('input[formcontrolname="isErrorFromFixtronix"]'),
    ).not.toBeChecked();

    // Le tech active PDR : la liste part de ZÉRO, rien n'est repris du cycle 0.
    await pdr.click({ force: true });
    await expect(pdr).toBeChecked();
    await goStep(page, 'Composants');
    await expect(page.locator('.selection__count')).toHaveText('0', {
        timeout: 8000,
    });
    await expect(page.getByText('Aucun composant ajouté')).toBeVisible();

    // Panne : les deux remarques et la catégorie sont vides.
    await goStep(page, 'Panne');
    await expect(page.locator('#diag-desc')).toHaveValue('');
    await expect(page.locator('#diag-extra')).toHaveValue('');
    await expect(
        page.locator('p-dropdown[formcontrolname="di_category_id"] .p-placeholder'),
    ).toBeVisible();

    // Informations : le diagnostic d'origine est affiché, en lecture seule.
    await goStep(page, 'Informations');
    const history = page.locator('.prev-cycles');
    await expect(history).toBeVisible();
    await expect(history.getByText('Flux original')).toBeVisible();
    await expect(history.getByText('QA-R0-Condensateur')).toBeVisible();
    await expect(history.getByText('QA-R0-Transistor')).toBeVisible();
    await expect(history.getByText(CATEGORY.category)).toBeVisible();
    await expect(history.locator('textarea, input')).toHaveCount(0);
});

test('B — retour en pause : reprend SA saisie du cycle 1, remarque redécoupée', async ({
    page,
}) => {
    const s = await seedRetour('B', {
        contain_pdr: true,
        can_be_repaired: true,
        array_composants: [{ nameComposant: 'QA-R1-Relais', quantity: 3 }],
        remarque_tech_diagnostic:
            'Panne retour R1\n\nRemarque technicien :\nRemarque retour R1',
        di_category_id: CATEGORY._id,
    } as Cycle1);
    await openDiagFresh(page, s.idnum);

    await goStep(page, 'Composants');
    await expect(page.locator('.selection__count')).toHaveText('1', {
        timeout: 8000,
    });
    await expect(
        page.locator('.selection table').getByText('QA-R1-Relais'),
    ).toBeVisible();
    await expect(
        page.locator('.selection table').getByText('QA-R0-Condensateur'),
    ).toHaveCount(0);

    await goStep(page, 'Panne');
    await expect(page.locator('#diag-desc')).toHaveValue('Panne retour R1');
    await expect(page.locator('#diag-extra')).toHaveValue('Remarque retour R1');
});
