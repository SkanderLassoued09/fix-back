import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Le chrono DÉMARRE à l'ouverture — cas T1410 (2026-09-30).
 *
 * Le chrono dépendait d'un watchQuery qui répondait AVANT que la DI ouverte soit
 * connue du composant : il s'arrêtait et ne repartait jamais (« le compteur ne
 * démarre pas directement »). Désormais le chrono est amorcé depuis la ligne puis
 * aligné sur l'instantané serveur `workTimer`.
 */

const TECH_ID = '6623d4fea953a0ebca67e7db';
const TECH_LIST = '/tickets/ticket/tech-di-list';

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);
type Seed = { diId: string; statId: string; idnum: string };

async function seed(
    suffix: string,
    status: string,
    stat: Record<string, unknown> = {},
): Promise<Seed> {
    const diId = `DI_tfo_${TAG}_${suffix}`;
    const statId = `STAT_tfo_${TAG}_${suffix}`;
    const idnum = `TFO-${TAG}-${suffix}`;
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: `QA chrono ouverture ${suffix}`,
            description: 'staged for di-timer-first-open',
            status,
            ignoreCount: 0,
            can_be_repaired: true,
            contain_pdr: true,
            di_category_id: 'CAT-TFO',
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
            status,
            ignoreCount: 0,
            retour_count: 0,
            pauseLogs: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            ...stat,
        } as any);
    });
    return { diId, statId, idnum };
}

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteMany({ _id: { $regex: `_tfo_${TAG}_` } } as any);
        await db.collection('stats').deleteMany({ _id: { $regex: `_tfo_${TAG}_` } } as any);
    });
});

async function openModal(page: Page, idnum: string, kind: 'diag' | 'repair') {
    await expect(async () => {
        await page.evaluate(() =>
            document.getElementById('webpack-dev-server-client-overlay')?.remove(),
        );
        const row = page.locator('tr', { hasText: idnum });
        if ((await row.count()) === 0) await page.reload();
        await expect(row.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    const row = page.locator('tr', { hasText: idnum }).first();
    await row.locator(`button:has(${kind === 'diag' ? '.pi-search' : '.pi-wrench'})`).click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({ timeout: 10000 });
}

const timerValue = (page: Page) =>
    page.locator('.sav-diag-header .sav-diag-timer__value');

const toSeconds = (hms: string) => {
    const [h, m, s] = hms.trim().split(':').map(Number);
    return h * 3600 + m * 60 + s;
};

async function expectTicking(page: Page) {
    const first = toSeconds(await timerValue(page).innerText());
    await expect
        .poll(async () => toSeconds(await timerValue(page).innerText()), {
            timeout: 5000,
        })
        .toBeGreaterThanOrEqual(first + 2);
}

async function stat(s: Seed) {
    return withDb((db) => db.collection('stats').findOne({ _id: s.statId } as any));
}

test('diag — PREMIÈRE ouverture (DIAGNOSTIC, aucun temps) : le chrono part tout seul', async ({ page }) => {
    const s = await seed('diag-first', 'DIAGNOSTIC');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');

    await expectTicking(page); // sans AUCUNE action de l'utilisateur
    await expect(page.locator('.sav-diag-header__pause')).toContainText('Mettre en pause');
    await expect
        .poll(async () => (await stat(s))?.diagRunStartedAt ?? null)
        .not.toBeNull(); // l'ancre serveur est posée
});

test('diag — réouverture d’une DI EN COURS : cumul + temps écoulé depuis l’ancre, et ça tourne', async ({ page }) => {
    const s = await seed('diag-running', 'INDIAGNOSTIC', {
        diag_time: '00:10:00',
        diagRunStartedAt: new Date(Date.now() - 5 * 60_000),
    });
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');

    await expect
        .poll(async () => toSeconds(await timerValue(page).innerText()))
        .toBeGreaterThanOrEqual(15 * 60); // 10 min cumulées + 5 min en cours
    await expectTicking(page);
});

test('répa — PREMIÈRE ouverture (REPARATION, aucun temps) : le chrono part tout seul', async ({ page }) => {
    const s = await seed('rep-first', 'REPARATION');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'repair');

    await expectTicking(page);
    await expect
        .poll(async () => (await stat(s))?.repRunStartedAt ?? null)
        .not.toBeNull();
});

test('répa — pause : rep_time = segments (plus de double comptage)', async ({ page }) => {
    const s = await seed('rep-double', 'INREPARATION', {
        rep_time: '00:00:00',
        repRunStartedAt: new Date(Date.now() - 20_000),
    });
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'repair');
    await expect(page.locator('.sav-diag-header__pause')).toContainText('Mettre en pause');

    await page.locator('.sav-diag-header__pause').click();
    await expect
        .poll(async () => ((await stat(s)) as any)?.repRunStartedAt == null ? 'fermé' : 'ouvert')
        .toBe('fermé');
    // Laisse passer la mutation de lap cliente : elle ne doit plus rien écrire.
    await page.waitForTimeout(1500);
    const st: any = await stat(s);
    const segSum = (st.repSegments ?? []).reduce(
        (a: number, g: any) => a + (new Date(g.stoppedAt).getTime() - new Date(g.startedAt).getTime()),
        0,
    );
    expect(Math.abs(toSeconds(st.rep_time) - Math.floor(segSum / 1000))).toBeLessThanOrEqual(1);
});
