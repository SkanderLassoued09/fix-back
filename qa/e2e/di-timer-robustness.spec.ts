import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile, tokenFor } from '../utils/auth';
import { withDb } from '../utils/mongo';
import { techId } from '../utils/accounts';
import { gqlPost } from '../utils/graphql';

/**
 * CHRONO diagnostic / réparation — robustesse « vrai utilisateur ».
 *
 * Bugs couverts (signalés en test manuel) :
 *  1. pause → fermer le modal → RECHARGER la page → rouvrir : le compteur
 *     AVANÇAIT alors que le bouton affichait « Reprendre ». Trois causes
 *     cumulées : course sur `this.di` dans `diagModal` (affecté après le
 *     `Promise.all`, donc `isPaused` faux au 1er tick du watchQuery),
 *     l'intervalle résiduel jamais coupé dans la branche « en pause », et
 *     `diagRunStartedAt` absent de la requête `searchTechDI`.
 *  2. « petit refresh » à chaque pause/reprise : c'était le `p-blockUI` global
 *     piloté par `isLoading` depuis les mutations de pause.
 *  3. durées absurdes : côté serveur l'ancre `repRunStartedAt` n'était JAMAIS
 *     fermée (pas de `closeRepLeg`), et côté front `padZero` ne tronquait pas
 *     tandis que `isValidTimeFormat` rejetait les heures à 3 chiffres.
 *
 * Auth : storageState TECH.
 */

const TECH_LIST = '/tickets/ticket/tech-di-list';
/** Format canonique : HH:MM:SS, HH pouvant dépasser 99 (le backend en émet). */
const HMS = /^\d{2,}:\d{2}:\d{2}$/;

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);
let TECH_ID = '';
test.beforeAll(async () => {
    TECH_ID = await withDb(techId);
});

interface Seed { diId: string; idnum: string }

async function seed(
    suffix: string,
    status: 'INDIAGNOSTIC' | 'DIAGNOSTIC_Pause' | 'INREPARATION' | 'REPARATION_Pause',
    over: { diag_time?: string; rep_time?: string; diagRunStartedAt?: Date | null; repRunStartedAt?: Date | null } = {},
): Promise<Seed> {
    const diId = `DI_timer_${TAG}_${suffix}`;
    const idnum = `TMR-${TAG}-${suffix}`;
    await withDb(async (db) => {
        const client = await db.collection('clients').findOne({ isDeleted: { $ne: true } });
        const now = new Date();
        await db.collection('dis').deleteOne({ _id: diId });
        await db.collection('stats').deleteMany({ _idDi: diId });
        await db.collection('dis').insertOne({
            _id: diId, _idnum: idnum, title: `QA chrono ${suffix}`,
            description: 'di-timer-robustness', status,
            can_be_repaired: true, contain_pdr: false, array_composants: [],
            di_category_id: 'CAT-TMR', client_id: client?._id ?? null,
            createdBy: TECH_ID, current_workers_ids: [TECH_ID], current_roles: ['Tech'],
            ignoreCount: 0, isDeleted: false,
            statusUpdatedAt: now, createdAt: now, updatedAt: now,
        });
        await db.collection('stats').insertOne({
            _id: `stat-${diId}`, _idDi: diId, diRef: diId,
            id_tech_diag: TECH_ID, id_tech_rep: TECH_ID, status,
            diag_time: over.diag_time ?? '00:00:10',
            rep_time: over.rep_time ?? '00:00:10',
            ...(over.diagRunStartedAt !== undefined ? { diagRunStartedAt: over.diagRunStartedAt } : {}),
            ...(over.repRunStartedAt !== undefined ? { repRunStartedAt: over.repRunStartedAt } : {}),
            ignoreCount: 0, retour_count: 0, pauseLogs: [],
            createdAt: now, updatedAt: now,
        });
    });
    return { diId, idnum };
}

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteMany({ _id: { $regex: `_timer_${TAG}_` } });
        await db.collection('stats').deleteMany({ _idDi: { $regex: `_timer_${TAG}_` } });
        await db.collection('notifications').deleteMany({ diId: { $regex: `_timer_${TAG}_` } });
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

const pauseButton = (page: Page) => page.locator('.sav-diag-header__pause');

/** Valeur brute du chrono affichée dans l'en-tête du modal. */
async function timerText(page: Page): Promise<string> {
    return (await page.locator('.sav-diag-timer__value').first().innerText()).trim();
}
async function timerSec(page: Page): Promise<number> {
    const t = await timerText(page);
    expect(t, `chrono malformé : « ${t} »`).toMatch(HMS);
    const [h, m, s] = t.split(':').map(Number);
    return h * 3600 + m * 60 + s;
}

/** Compte les apparitions du voile de chargement global (`p-blockUI`). */
async function watchOverlay(page: Page) {
    await page.evaluate(() => {
        (window as any).__blockCount = 0;
        const obs = new MutationObserver((muts) => {
            for (const m of muts) {
                m.addedNodes.forEach((n) => {
                    const el = n as HTMLElement;
                    if (el.nodeType === 1 && (el.classList?.contains('p-blockui') ||
                        el.querySelector?.('.p-blockui'))) {
                        (window as any).__blockCount++;
                    }
                });
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    });
}
const overlayCount = (page: Page) => page.evaluate(() => (window as any).__blockCount ?? 0);

/** Compte les rechargements complets de liste. */
function reloadCounter(page: Page) {
    const c = { n: 0 };
    page.on('request', (r) => {
        // DEUX requêtes rechargent la liste selon qu'une recherche est active :
        // `searchTechDI` OU `getDiForTech`. L'ancien garde ne comptait que la
        // première — c'est pourquoi le rechargement sur pause passait inaperçu.
        const b = r.postData() || '';
        if (r.method() === 'POST' && r.url().includes('/graphql') &&
            (b.includes('searchTechDI') || b.includes('getDiForTech'))) c.n++;
    });
    return c;
}

function collectPageErrors(page: Page): string[] {
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(e.message));
    return errs;
}

// ───────────────────────────── LE BUG SIGNALÉ ────────────────────────────────
test('diag — pause → fermer → RECHARGER la page → rouvrir : chrono GELÉ, libellé « Reprendre »', async ({ page }) => {
    const errs = collectPageErrors(page);
    const s = await seed('frozen', 'INDIAGNOSTIC');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');
    await expect(pauseButton(page)).toContainText('Mettre en pause');

    await pauseButton(page).click();
    await expect(pauseButton(page)).toContainText('Reprendre');
    await expect.poll(() => withDb(async (db) =>
        (await db.collection('dis').findOne({ _id: s.diId }))?.status,
    ), { timeout: 12000 }).toBe('DIAGNOSTIC_Pause');

    // Fermer le modal, RECHARGER la page, rouvrir : c'est le scénario exact.
    await page.keyboard.press('Escape');
    await page.reload();
    await openModal(page, s.idnum, 'diag');

    await expect(pauseButton(page)).toContainText('Reprendre');
    const first = await timerSec(page);
    await page.waitForTimeout(3500);
    const second = await timerSec(page);
    expect(second, `le chrono a avancé de ${second - first}s sur une DI en pause`).toBe(first);

    expect(errs, errs.join('\n')).toHaveLength(0);
});

test('diag — après ce refresh, UN SEUL clic « Reprendre » relance le chrono', async ({ page }) => {
    const s = await seed('resume', 'DIAGNOSTIC_Pause', { diagRunStartedAt: null });
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');
    await expect(pauseButton(page)).toContainText('Reprendre');

    const before = await timerSec(page);
    await pauseButton(page).click(); // UN seul clic (le toggle inversé le mangeait)
    await expect(pauseButton(page)).toContainText('Mettre en pause');
    await expect.poll(() => withDb(async (db) =>
        (await db.collection('dis').findOne({ _id: s.diId }))?.status,
    ), { timeout: 12000 }).toBe('INDIAGNOSTIC');

    await expect.poll(() => timerSec(page), { timeout: 12000 })
        .toBeGreaterThan(before);
});

test('diag — pause manuelle puis refresh : la DI RESTE en pause (pas d’auto-reprise)', async ({ page }) => {
    const s = await seed('noauto', 'INDIAGNOSTIC');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');
    await pauseButton(page).click();
    await expect.poll(() => withDb(async (db) =>
        (await db.collection('dis').findOne({ _id: s.diId }))?.status,
    ), { timeout: 12000 }).toBe('DIAGNOSTIC_Pause');

    await page.reload();
    await openModal(page, s.idnum, 'diag');
    await page.waitForTimeout(2500);

    expect(await withDb(async (db) =>
        (await db.collection('dis').findOne({ _id: s.diId }))?.status,
    )).toBe('DIAGNOSTIC_Pause');
    await expect(pauseButton(page)).toContainText('Reprendre');
});

// ─────────────────────────── OVERLAY / RECHARGEMENT ──────────────────────────
test('diag — pause puis reprise : AUCUN voile de chargement, AUCUN rechargement de liste', async ({ page }) => {
    const s = await seed('overlay', 'INDIAGNOSTIC');
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');
    await expect(pauseButton(page)).toContainText('Mettre en pause');

    const reloads = reloadCounter(page);
    await watchOverlay(page);

    await pauseButton(page).click();
    await expect(pauseButton(page)).toContainText('Reprendre');
    // Attendre la confirmation SERVEUR avant de reprendre — c'est ce que fait un
    // utilisateur réel (il voit la ligne basculer), et ça évite de se heurter à
    // la garde anti double-clic du bouton.
    await expect.poll(() => withDb(async (db) =>
        (await db.collection('dis').findOne({ _id: s.diId }))?.status,
    ), { timeout: 12000 }).toBe('DIAGNOSTIC_Pause');

    await pauseButton(page).click();
    await expect(pauseButton(page)).toContainText('Mettre en pause');
    await page.waitForTimeout(1500);

    // Le voile est la gêne visible : il ne doit JAMAIS apparaître sur pause/reprise.
    expect(await overlayCount(page), 'le p-blockUI ne doit jamais apparaître sur pause/reprise').toBe(0);
    // Un rafraîchissement de FOND déclenché par le temps réel reste acceptable
    // (il garde la liste juste) — tant qu'il est silencieux. Ce qui est interdit,
    // c'est que le CLIC lui-même recharge : au plus un refresh temps réel par action.
    expect(reloads.n, `rechargements de liste ×${reloads.n}`).toBeLessThanOrEqual(2);
});

// ──────────────────────────────── FORMAT ─────────────────────────────────────
test('diag — une durée ≥ 100 h est AFFICHÉE, pas remise à zéro', async ({ page }) => {
    // Le backend émet volontairement HH > 99 ; le front la rejetait et
    // retombait sur 00:00:00, effaçant le temps accumulé à l'écran.
    const s = await seed('bighours', 'DIAGNOSTIC_Pause', {
        diag_time: '100:00:30', diagRunStartedAt: null,
    });
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');

    await expect.poll(() => timerText(page), { timeout: 12000 }).toBe('100:00:30');
});

test('diag — un diag_time CORROMPU affiche 00:00:00 sans erreur JS', async ({ page }) => {
    const errs = collectPageErrors(page);
    const s = await seed('corrupt', 'DIAGNOSTIC_Pause', {
        diag_time: 'undefined', diagRunStartedAt: null,
    });
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'diag');

    const t = await timerText(page);
    expect(t, `chrono malformé : « ${t} »`).toMatch(HMS);
    expect(t).toBe('00:00:00');
    expect(errs, errs.join('\n')).toHaveLength(0);
});

// ──────────────────────────── RÉPARATION / SERVEUR ───────────────────────────
test('répa — la pause FERME l’ancre serveur et cumule dans rep_time', async ({ page }) => {
    const s = await seed('replock', 'INREPARATION', {
        rep_time: '00:00:10',
        repRunStartedAt: new Date(Date.now() - 30_000), // 30 s de segment ouvert
    });
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'repair');
    await expect(pauseButton(page)).toContainText('Mettre en pause');

    await pauseButton(page).click();
    await expect.poll(() => withDb(async (db) =>
        (await db.collection('dis').findOne({ _id: s.diId }))?.status,
    ), { timeout: 12000 }).toBe('REPARATION_Pause');

    const stat: any = await withDb(async (db) =>
        db.collection('stats').findOne({ _idDi: s.diId }),
    );
    // L'ancre DOIT être vidée — sinon elle survit et fait exploser le calcul.
    expect(stat?.repRunStartedAt ?? null, 'repRunStartedAt doit repasser à null').toBeNull();
    expect(String(stat?.rep_time)).toMatch(HMS);
    const [h, m, sec] = String(stat.rep_time).split(':').map(Number);
    expect(h * 3600 + m * 60 + sec, 'le segment doit être cumulé dans rep_time')
        .toBeGreaterThanOrEqual(35);
});

test('répa — une ancre PÉRIMÉE n’affiche pas des centaines d’heures', async ({ page }) => {
    // Reproduit le « 777 » : ancre vieille de 5 jours restée ouverte en base.
    const s = await seed('stale', 'REPARATION_Pause', {
        rep_time: '00:02:00',
        repRunStartedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
    });
    await page.goto(TECH_LIST);
    await openModal(page, s.idnum, 'repair');

    const t = await timerText(page);
    expect(t, `chrono malformé : « ${t} »`).toMatch(HMS);
    const [h] = t.split(':').map(Number);
    expect(h, `le chrono affiche ${t} — l'ancre périmée n'a pas été neutralisée`)
        .toBeLessThan(24);
});

test('API — rep_time malformé REFUSÉ au point d’écriture', async ({ request }) => {
    const s = await seed('badwrite', 'INREPARATION');
    const before: any = await withDb(async (db) =>
        db.collection('stats').findOne({ _idDi: s.diId }),
    );
    const r = await gqlPost(
        request,
        `mutation { lapTimeForPauseAndGetBackForReaparation(_id: "stat-${s.diId}", repTime: "777.65.6h") }`,
        tokenFor('TECH'),
    );
    expect(r.errors, 'une durée malformée doit être refusée').not.toBeNull();

    const after: any = await withDb(async (db) =>
        db.collection('stats').findOne({ _idDi: s.diId }),
    );
    expect(after?.rep_time).toBe(before?.rep_time);
});
