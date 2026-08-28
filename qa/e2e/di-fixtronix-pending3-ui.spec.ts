import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';
import { techId } from '../utils/accounts';

/**
 * FIXTRONIX → PENDING3 (jamais PENDING2/Pricing) — VRAI test UI.
 *
 * Reproduit EXACTEMENT le flux qui envoyait FT-05 en PENDING2 : un retour
 * réparable + SANS PDR, fini via le bouton « Fin diagnostique retour » du modal
 * (le tech a décoché PDR), qui appelle la mutation `changeStatusPending2`. Cette
 * mutation ne portait AUCUNE logique Fixtronix → PENDING2. La garde métier
 * (di.service.ts changeStatusPending2, lecture flag DI persistant OU log de
 * cycle) redirige désormais vers PENDING3.
 *
 * 3 cas :
 *   A — bug historique : Fixtronix décoché + PDR décoché → « Fin diagnostique
 *       retour » (changeStatusPending2) → doit finir PENDING3 (garde via flag DI).
 *   B — chemin « erreur marquée » : Fixtronix coché + PDR décoché → « Envoyer
 *       vers finir » (changestatusToFinishReparation) → PENDING3.
 *   C — non-régression client : aucune erreur Fixtronix → « Fin diagnostique
 *       retour » → PENDING2 (le client reste facturé).
 *
 * Auth : storageState TECH (username « tech », `_id` résolu à l'exécution).
 */

const TECH_LIST = '/tickets/ticket/tech-di-list';

/** Résolu en beforeAll : deux bases coexistent, l'id figé pointait la mauvaise. */
let TECH_ID = '';
test.beforeAll(async () => {
    TECH_ID = await withDb(techId);
});

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);

type Seed = { diId: string; idnum: string };

/** Retour réparable + sans PDR, assigné au tech. `fixtronix` pose le verdict
 *  sur la DI (flag persistant) ET sur le snapshot du cycle (log). */
async function seedRetour(
    suffix: string,
    fixtronix: boolean,
): Promise<Seed> {
    const diId = `DI_fxui_${TAG}_${suffix}`;
    const idnum = `FXUI-${TAG}-${suffix}`;
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        const now = new Date();
        await db.collection('dis').deleteOne({ _id: diId });
        await db.collection('stats').deleteMany({ _idDi: diId });
        await db.collection('logsdis').deleteMany({ _idDi: diId });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: `QA Fixtronix UI ${suffix}`,
            description: 'retour réparable sans PDR',
            status: 'INDIAGNOSTIC',
            ignoreCount: 1,
            can_be_repaired: true,
            contain_pdr: false,
            array_composants: [],
            ...(fixtronix ? { isErrorFromFixtronix: true } : {}),
            di_category_id: 'CAT-FXUI',
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
        // Snapshot LogsDi du cycle (obligatoire : tech_startDiagnostic le met à
        // jour au clic + le routage retour le lit).
        await db.collection('logsdis').insertOne({
            _id: `log-${diId}`,
            _idDi: diId,
            idIgnore: 1,
            can_be_repaired: true,
            contain_pdr: false,
            array_composants: [],
            isErrorFromFixtronix: fixtronix,
            createdAt: now,
            updatedAt: now,
        });
    });
    return { diId, idnum };
}

async function dbStatus(diId: string): Promise<string | undefined> {
    return withDb(async (db) => {
        const d = await db.collection('dis').findOne({ _id: diId });
        return d?.status;
    });
}

async function openDiag(page: Page, idnum: string) {
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

async function setToggle(page: Page, control: string, checked: boolean) {
    const box = page.locator(`input[formcontrolname="${control}"]`);
    await expect(box).toBeVisible({ timeout: 8000 });
    if ((await box.isChecked()) !== checked) {
        await box.click({ force: true }); // le switch est un vrai <input checkbox>
    }
    // VÉRIFIE l'état réel (sinon un toggle silencieux fausse le chemin testé).
    await expect(box).toBeChecked({ checked, timeout: 4000 });
}

async function clickFinishButton(page: Page, label: string) {
    await goStep(page, 'Résumé');
    const btn = page.locator('button', { hasText: label });
    await expect(btn).toBeEnabled({ timeout: 8000 });
    await btn.click();
    await page
        .locator('.p-confirm-dialog .p-confirm-dialog-accept')
        .click();
}

const seeds: string[] = [];
test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteMany({ _id: { $regex: `_fxui_${TAG}_` } });
        await db.collection('stats').deleteMany({ _idDi: { $regex: `_fxui_${TAG}_` } });
        await db
            .collection('logsdis')
            .deleteMany({ _idDi: { $regex: `_fxui_${TAG}_` } });
        await db
            .collection('notifications')
            .deleteMany({ diId: { $regex: `_fxui_${TAG}_` } });
    });
});

test('A — Fixtronix DÉCOCHÉ + sans PDR → « Fin diagnostique retour » → PENDING3 (LE bug + clobber)', async ({
    page,
}) => {
    const s = await seedRetour('A', true); // flag DI Fixtronix true + log true
    seeds.push(s.diId);
    await page.goto(TECH_LIST);
    await openDiag(page, s.idnum);
    await goStep(page, 'Validation');
    // Reproduit l'échec EXACT : PDR décoché ET Fixtronix décoché (le tech ne
    // marque pas l'erreur). Décocher Fixtronix ⇒ tech_startDiagnostic réécrit le
    // log à false (le « clobber »). isPdr=false ⇒ bouton « Fin diagnostique
    // retour » ⇒ mutation changeStatusPending2 (le chemin qui cassait).
    await setToggle(page, 'isErrorFromFixtronix', false);
    await setToggle(page, 'isPdr', false);
    // Plus AUCUN grisage sur le flux retour : les deux boutons sont cliquables,
    // le backend garantit le statut (garde Fixtronix + backstop non-réparable).
    // On vérifie donc l'inverse d'avant — les deux sont bien actifs.
    await goStep(page, 'Résumé');
    for (const label of ['Envoyer vers finir', 'Fin diagnostique retour']) {
        await expect(
            page.locator('.actions button', { hasText: label }),
            `« ${label} » doit être cliquable`,
        ).toBeEnabled({ timeout: 8000 });
    }
    await clickFinishButton(page, 'Fin diagnostique retour');

    // Garde Fixtronix (flag DI persistant) ⇒ PENDING3, JAMAIS PENDING2.
    await expect
        .poll(() => dbStatus(s.diId), { timeout: 15000 })
        .toBe('PENDING3');
    expect(await dbStatus(s.diId)).not.toBe('PENDING2');
});

test('C — erreur CLIENT (pas Fixtronix) + sans PDR → « Fin diagnostique retour » → PENDING2 (facturé)', async ({
    page,
}) => {
    const s = await seedRetour('C', false); // ni flag DI ni log Fixtronix
    seeds.push(s.diId);
    await page.goto(TECH_LIST);
    await openDiag(page, s.idnum);
    await goStep(page, 'Validation');
    await setToggle(page, 'isPdr', false);
    await setToggle(page, 'isErrorFromFixtronix', false);
    await clickFinishButton(page, 'Fin diagnostique retour');

    // Erreur client → facturé → PENDING2 (la garde Fixtronix NE s'applique PAS).
    await expect
        .poll(() => dbStatus(s.diId), { timeout: 15000 })
        .toBe('PENDING2');
});
