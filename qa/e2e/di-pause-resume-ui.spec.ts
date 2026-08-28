import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Pause / Reprise du chrono DI (diagnostic ET réparation) — régression UI.
 *
 * Bugs corrigés (fix front, `tech-di-list` + `tech-repair-list`) :
 *   1. « il faut cliquer deux fois » — le LIBELLÉ du bouton venait du drapeau
 *      chrono (`timer.isRunning`, qui dérive) alors que l'ACTION vient du STATUT
 *      de la DI. Quand ils divergeaient, le 1er clic partait dans le mauvais
 *      sens. Fix : le libellé vient désormais du MÊME statut que l'action.
 *   2. « petit refresh de la page sans raison » — pause/reprise déclenchaient un
 *      rechargement complet de la liste (`loadData()` → `searchTechDI`, no-cache,
 *      overlay isLoading) directement ET via `requestTechListRefresh`. Fix :
 *      supprimés — la ligne est patchée de façon optimiste, sans reload.
 *   3. Fermeture d'onglet avec une DI EN COURS (non pausée) : `beforeunload`
 *      AVERTIT (prompt natif) ET gèle en best-effort (auto-pause).
 *
 * Ce que prouve ce spec :
 *   - UN SEUL clic pause ⇒ statut `*_Pause`, libellé « Reprendre ».
 *   - UN SEUL clic reprise ⇒ statut actif, libellé « Mettre en pause ».
 *   - AUCUN `searchTechDI` (rechargement liste) déclenché par l'action.
 *   - double-clic rapide = idempotent (reste pausé, pas de crash).
 *   - beforeunload avec DI en cours : `preventDefault` (prompt) + auto-pause DB.
 *
 * Auth : storageState TECH (username `tech`, _id 6623d4fea953a0ebca67e7db) —
 * c'est l'identité que les gardes d'affectation (`isDiAssignedToMe`, sur
 * `id_tech_diag`/`id_tech_rep`) comparent aux jetons `localStorage._id/username`.
 */

const TECH_ID = '6623d4fea953a0ebca67e7db';
const TECH_LIST = '/tickets/ticket/tech-di-list';

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);

type Seed = { diId: string; statId: string; idnum: string };
const seeds: Seed[] = [];

/** Seed a DI + Stat assigned to the running tech, in the given active status. */
async function seed(
    suffix: string,
    diStatus: 'INDIAGNOSTIC' | 'INREPARATION',
): Promise<Seed> {
    const diId = `DI_pauseui_${TAG}_${suffix}`;
    const statId = `STAT_pauseui_${TAG}_${suffix}`;
    const idnum = `PAU-${TAG}-${suffix}`;
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: `QA Pause/Reprise ${suffix}`,
            description: 'staged for di-pause-resume-ui',
            status: diStatus,
            can_be_repaired: true,
            contain_pdr: true,
            di_category_id: 'CAT-PAU',
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
            _id: statId,
            _idDi: diId,
            diRef: diId,
            id_tech_diag: TECH_ID,
            id_tech_rep: TECH_ID,
            status: diStatus,
            diag_time: '00:00:10',
            rep_time: diStatus === 'INREPARATION' ? '00:00:10' : '',
            ignoreCount: 0,
            retour_count: 0,
            pauseLogs: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
    const s = { diId, statId, idnum };
    seeds.push(s);
    return s;
}

test.afterAll(async () => {
    await withDb(async (db) => {
        await db
            .collection('dis')
            .deleteMany({ _id: { $regex: `_pauseui_${TAG}_` } });
        await db
            .collection('stats')
            .deleteMany({ _id: { $regex: `_pauseui_${TAG}_` } });
    });
});

async function dbStatus(diId: string): Promise<string | undefined> {
    return withDb(async (db) => {
        const d = await db.collection('dis').findOne({ _id: diId });
        return d?.status;
    });
}

/** Locate the seeded row (reloading the list until it shows up). */
async function findRow(page: Page, idnum: string) {
    await expect(async () => {
        const row = page.locator('tr', { hasText: idnum });
        if ((await row.count()) === 0) await page.reload();
        await expect(row.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    return page.locator('tr', { hasText: idnum }).first();
}

/** Open the diagnostic (🔍) or repair (🔧) modal from the row. */
async function openModal(page: Page, idnum: string, kind: 'diag' | 'repair') {
    const row = await findRow(page, idnum);
    const icon = kind === 'diag' ? '.pi-search' : '.pi-wrench';
    await row.locator(`button:has(${icon})`).click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({
        timeout: 10000,
    });
}

/** The single pause/resume button lives in the shared modal header. */
function pauseButton(page: Page) {
    return page.locator('.sav-diag-header__pause');
}

/**
 * Count full-list reloads (`searchTechDI`, the no-cache query fired by
 * loadData()) so we can prove pause/resume triggers ZERO of them.
 */
function reloadCounter(page: Page) {
    const c = { n: 0 };
    page.on('request', (req) => {
        if (req.method() !== 'POST' || !req.url().includes('/graphql')) return;
        if ((req.postData() || '').includes('searchTechDI')) c.n++;
    });
    return c;
}

test('diag — un seul clic pause puis reprise ; libellé suit ; zéro reload', async ({
    page,
}) => {
    const s = await seed('diag', 'INDIAGNOSTIC');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');

    // Départ : chrono actif → « Mettre en pause ».
    await expect(pauseButton(page)).toContainText('Mettre en pause');

    const reloads = reloadCounter(page);

    // UN clic pause.
    await pauseButton(page).click();
    await expect
        .poll(() => dbStatus(s.diId), { timeout: 12000 })
        .toBe('DIAGNOSTIC_Pause');
    await expect(pauseButton(page)).toContainText('Reprendre');

    // UN clic reprise.
    await pauseButton(page).click();
    await expect
        .poll(() => dbStatus(s.diId), { timeout: 12000 })
        .toBe('INDIAGNOSTIC');
    await expect(pauseButton(page)).toContainText('Mettre en pause');

    // Aucun rechargement de liste déclenché par l'action.
    expect(reloads.n, `searchTechDI reloads ×${reloads.n}`).toBe(0);
});

test('réparation — un seul clic pause puis reprise ; libellé suit ; zéro reload', async ({
    page,
}) => {
    const s = await seed('rep', 'INREPARATION');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'repair');

    await expect(pauseButton(page)).toContainText('Mettre en pause');

    const reloads = reloadCounter(page);

    // UN clic pause.
    await pauseButton(page).click();
    await expect
        .poll(() => dbStatus(s.diId), { timeout: 12000 })
        .toBe('REPARATION_Pause');
    await expect(pauseButton(page)).toContainText('Reprendre');

    // UN clic reprise.
    await pauseButton(page).click();
    await expect
        .poll(() => dbStatus(s.diId), { timeout: 12000 })
        .toBe('INREPARATION');
    await expect(pauseButton(page)).toContainText('Mettre en pause');

    expect(reloads.n, `searchTechDI reloads ×${reloads.n}`).toBe(0);
});

test('diag — double-clic rapide sur pause = idempotent (reste pausé, pas de crash)', async ({
    page,
}) => {
    const s = await seed('dbl', 'INDIAGNOSTIC');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');

    await expect(pauseButton(page)).toContainText('Mettre en pause');

    // Deux clics quasi simultanés : le back est idempotent (pause = update
    // sans garde ; le 2e est absorbé). L'UI reste cohérente : PAUSÉ.
    await pauseButton(page).click();
    await pauseButton(page).click({ force: true }).catch(() => {});

    await expect
        .poll(() => dbStatus(s.diId), { timeout: 12000 })
        .toBe('DIAGNOSTIC_Pause');
    await expect(pauseButton(page)).toContainText('Reprendre');

    // Et une reprise unique repart proprement.
    await pauseButton(page).click();
    await expect
        .poll(() => dbStatus(s.diId), { timeout: 12000 })
        .toBe('INDIAGNOSTIC');
});

test('beforeunload avec DI en cours → prompt natif (preventDefault) + auto-pause best-effort', async ({
    page,
}) => {
    const s = await seed('unload', 'INDIAGNOSTIC');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');
    await expect(pauseButton(page)).toContainText('Mettre en pause');

    // Laisse le chrono démarrer (getTimeSpent → startStopwatch → isRunning=true),
    // condition de `hasRunningUnpausedDi()`.
    await page.waitForTimeout(2000);

    // Dispatch synthétique : le handler `onWindowBeforeUnload` doit annuler
    // l'événement (⇒ le navigateur afficherait « Quitter le site ? ») ET
    // déclencher le gel best-effort (auto-pause).
    const prevented = await page.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
    });
    expect(prevented, 'beforeunload doit être annulé (prompt natif)').toBe(true);

    // Best-effort auto-pause : la DI passe en pause côté serveur.
    await expect
        .poll(() => dbStatus(s.diId), { timeout: 12000 })
        .toBe('DIAGNOSTIC_Pause');
});
