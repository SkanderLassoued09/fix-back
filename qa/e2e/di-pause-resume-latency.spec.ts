import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Pause / Reprise sous LATENCE réseau — la course qui imposait un 2e clic.
 *
 * En local la pause répond en ~10 ms : la course est invisible. En production
 * la réponse de `changeToDiagnosticInPause` arrivait APRÈS un « Reprendre »
 * rapide et repassait l'écran en pause alors que le serveur tournait (ou les
 * deux requêtes se croisaient côté serveur). On la rend reproductible en
 * retardant les mutations de pause de ~1,5 s.
 *
 * Ce que prouve ce spec :
 *   - pendant que la pause est en vol, le bouton est INACTIF (clic ignoré) ;
 *   - une fois confirmée, UN clic reprend ; libellé, `dis.status` et
 *     `stats.status` concordent ; aucun log de pause ne reste ouvert ;
 *   - une pause refusée par le serveur est ANNULÉE à l'écran (pas de désync).
 */

const TECH_ID = '6623d4fea953a0ebca67e7db';
const TECH_LIST = '/tickets/ticket/tech-di-list';
const PAUSE_DELAY_MS = 1500;

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);

type Seed = { diId: string; statId: string; idnum: string };

async function seed(
    suffix: string,
    diStatus: 'INDIAGNOSTIC' | 'INREPARATION',
): Promise<Seed> {
    const diId = `DI_pauselat_${TAG}_${suffix}`;
    const statId = `STAT_pauselat_${TAG}_${suffix}`;
    const idnum = `PLT-${TAG}-${suffix}`;
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: `QA Pause latence ${suffix}`,
            description: 'staged for di-pause-resume-latency',
            status: diStatus,
            can_be_repaired: true,
            contain_pdr: true,
            di_category_id: 'CAT-PLT',
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
        } as any);
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
        } as any);
    });
    return { diId, statId, idnum };
}

test.afterAll(async () => {
    await withDb(async (db) => {
        await db
            .collection('dis')
            .deleteMany({ _id: { $regex: `_pauselat_${TAG}_` } } as any);
        await db
            .collection('stats')
            .deleteMany({ _id: { $regex: `_pauselat_${TAG}_` } } as any);
    });
});

async function dbState(s: Seed) {
    return withDb(async (db) => {
        const d = await db.collection('dis').findOne({ _id: s.diId } as any);
        const st = await db
            .collection('stats')
            .findOne({ _id: s.statId } as any);
        const logs = (st?.pauseLogs ?? []) as any[];
        return {
            di: d?.status as string | undefined,
            stat: st?.status as string | undefined,
            openLogs: logs.filter((l) => l.pauseEnd == null).length,
            logs: logs.length,
        };
    });
}

async function openModal(page: Page, idnum: string, kind: 'diag' | 'repair') {
    await expect(async () => {
        const row = page.locator('tr', { hasText: idnum });
        if ((await row.count()) === 0) await page.reload();
        await expect(row.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    const row = page.locator('tr', { hasText: idnum }).first();
    const icon = kind === 'diag' ? '.pi-search' : '.pi-wrench';
    await row.locator(`button:has(${icon})`).click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({
        timeout: 10000,
    });
}

const pauseButton = (page: Page) => page.locator('.sav-diag-header__pause');

/** Retarde (ou fait échouer) les mutations de PAUSE uniquement. */
async function slowPause(page: Page, mode: 'delay' | 'fail') {
    await page.route('**/graphql', async (route) => {
        const body = route.request().postData() || '';
        const isPause =
            body.includes('changeToDiagnosticInPause') ||
            body.includes('changeToReparationInPause');
        if (!isPause) return route.continue();
        if (mode === 'fail') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    data: null,
                    errors: [{ message: 'QA — pause refusée' }],
                }),
            });
        }
        await new Promise((r) => setTimeout(r, PAUSE_DELAY_MS));
        return route.continue();
    });
}

for (const kind of ['diag', 'repair'] as const) {
    const active = kind === 'diag' ? 'INDIAGNOSTIC' : 'INREPARATION';
    const paused = kind === 'diag' ? 'DIAGNOSTIC_Pause' : 'REPARATION_Pause';

    test(`${kind} — pause lente puis reprise rapide : un seul clic suffit`, async ({
        page,
    }) => {
        const s = await seed(`${kind}-lat`, active);
        await slowPause(page, 'delay');
        await page.goto(TECH_LIST);
        await openModal(page, s.idnum, kind);
        await expect(pauseButton(page)).toContainText('Mettre en pause');

        await pauseButton(page).click();
        // Pause en vol : bouton inactif, le clic « Reprendre » impatient est ignoré.
        await expect(pauseButton(page)).toBeDisabled();
        await pauseButton(page).click({ force: true }).catch(() => {});

        await expect.poll(async () => (await dbState(s)).di).toBe(paused);
        await expect(pauseButton(page)).toBeEnabled({ timeout: 10000 });
        await expect(pauseButton(page)).toContainText('Reprendre');

        // UN clic reprise, qui tient (la réponse tardive ne le défait plus).
        await pauseButton(page).click();
        await expect.poll(async () => (await dbState(s)).di).toBe(active);
        await page.waitForTimeout(PAUSE_DELAY_MS + 500);
        await expect(pauseButton(page)).toContainText('Mettre en pause');

        const st = await dbState(s);
        expect(st).toMatchObject({ di: active, stat: active, openLogs: 0 });
        expect(st.logs).toBe(1);
    });

    test(`${kind} — pause refusée par le serveur : écran annulé, pas de désync`, async ({
        page,
    }) => {
        const s = await seed(`${kind}-err`, active);
        await slowPause(page, 'fail');
        await page.goto(TECH_LIST);
        await openModal(page, s.idnum, kind);
        await expect(pauseButton(page)).toContainText('Mettre en pause');

        await pauseButton(page).click();
        // Retour à l'état réel (toujours en cours) + bouton réutilisable.
        await expect(pauseButton(page)).toContainText('Mettre en pause', {
            timeout: 10000,
        });
        await expect(pauseButton(page)).toBeEnabled();
        expect((await dbState(s)).di).toBe(active);
    });
}
