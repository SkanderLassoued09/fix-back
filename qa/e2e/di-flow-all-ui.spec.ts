import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile, tokenFor } from '../utils/auth';
import { withDb } from '../utils/mongo';
import { techId } from '../utils/accounts';
import { gqlPost } from '../utils/graphql';

/**
 * SORTIE DE DIAGNOSTIC — la matrice FT-01…FT-BL, pilotée dans le VRAI modal tech.
 *
 * Le chemin de mutation dépend du BOUTON cliqué (les vérifs API ne le voyaient
 * pas). Ce test ouvre chaque DI, règle les bascules du cas, vérifie le GATING
 * COMPLET des boutons de fin (celui attendu activé, TOUS les autres désactivés
 * ou absents), clique, et assert le statut final.
 *
 * Contrat couvert :
 *   FT-01  Original + réparable + PDR                → MagasinEstimation
 *   FT-02  Original + réparable + sans PDR           → PENDING2
 *   FT-03  Original + NON réparable                  → PENDING2 (puis IRREPARABLE au prix)
 *   FT-04  Retour + Fixtronix + réparable + PDR      → MagasinEstimation → PENDING3 (jamais Pricing)
 *   FT-05  Retour + Fixtronix + réparable + sans PDR → PENDING3   (2 boutons possibles, cf. FT-05b)
 *   FT-06  Retour + Fixtronix + NON réparable        → IRREPARABLE
 *   FT-07  Retour + client + réparable + PDR         → MagasinEstimation
 *   FT-08  Retour + client + réparable + sans PDR    → PENDING2
 *   FT-09  Retour + client + NON réparable           → IRREPARABLE
 *   FT-BL  Réparée + attente BL                      → WAITING_BL
 *
 * Régression clé : FT-06/FT-09 (retour NON réparable) restaient BLOQUÉS en
 * INDIAGNOSTIC (bug getRawValue).
 *
 * Auth : storageState TECH (username « tech », `_id` résolu à l'exécution).
 */

const TECH_LIST = '/tickets/ticket/tech-di-list';

test.use({ storageState: authFile('TECH') });
test.describe.configure({ mode: 'serial' });

const TAG = Date.now().toString(36);

/** Résolu en beforeAll : deux bases coexistent, l'id figé pointait la mauvaise. */
let TECH_ID = '';
test.beforeAll(async () => {
    TECH_ID = await withDb(techId);
});

/** Libellés exacts des 4 CTA de fin du modal (steps/diagnostic-summary-step). */
const BTN = {
    finish: 'Finir le diagnostic',
    notReparable: 'Terminer (non réparable)',
    retourFinish: 'Fin diagnostique retour',
    retourSend: 'Envoyer vers finir',
} as const;
const ALL_BUTTONS = Object.values(BTN);

type ToggleOp = [control: 'isPdr' | 'isReparable' | 'isErrorFromFixtronix', checked: boolean];
interface Case {
    key: string;
    label: string;
    flow: 'orig' | 'retour';
    rep: boolean;
    pdr: boolean;
    fix: boolean; // verdict Fixtronix seedé (DI + log)
    toggles: ToggleOp[]; // bascules à appliquer dans « Validation »
    button: string; // bouton de fin attendu (activé)
    expect: string; // statut final attendu
}

const CASES: Case[] = [
    { key: '01', label: 'Original + réparable + PDR',                flow: 'orig',   rep: true,  pdr: true,  fix: false, toggles: [],                             button: BTN.finish,        expect: 'MagasinEstimation' },
    { key: '02', label: 'Original + réparable + sans PDR',           flow: 'orig',   rep: true,  pdr: false, fix: false, toggles: [['isPdr', false]],             button: BTN.finish,        expect: 'PENDING2' },
    { key: '03', label: 'Original + NON réparable',                  flow: 'orig',   rep: false, pdr: false, fix: false, toggles: [['isReparable', false]],       button: BTN.notReparable,  expect: 'PENDING2' },
    { key: '04', label: 'Retour + Fixtronix + réparable + PDR',      flow: 'retour', rep: true,  pdr: true,  fix: true,  toggles: [],                             button: BTN.retourFinish,  expect: 'MagasinEstimation' },
    { key: '05', label: 'Retour + Fixtronix + réparable + sans PDR', flow: 'retour', rep: true,  pdr: false, fix: true,  toggles: [['isPdr', false], ['isErrorFromFixtronix', false]], button: BTN.retourFinish, expect: 'PENDING3' },
    { key: '06', label: 'Retour + Fixtronix + NON réparable',        flow: 'retour', rep: false, pdr: false, fix: true,  toggles: [['isReparable', false]],       button: BTN.retourSend,    expect: 'IRREPARABLE' },
    { key: '07', label: 'Retour + client + réparable + PDR',         flow: 'retour', rep: true,  pdr: true,  fix: false, toggles: [],                             button: BTN.retourFinish,  expect: 'MagasinEstimation' },
    { key: '08', label: 'Retour + client + réparable + sans PDR',    flow: 'retour', rep: true,  pdr: false, fix: false, toggles: [['isPdr', false]],             button: BTN.retourFinish,  expect: 'PENDING2' },
    { key: '09', label: 'Retour + client + NON réparable',           flow: 'retour', rep: false, pdr: false, fix: false, toggles: [['isReparable', false]],       button: BTN.retourSend,    expect: 'IRREPARABLE' },
    // FT-05b — MÊME cas que FT-05 mais le tech LAISSE « Erreur Fixtronix » COCHÉE
    // (le geste réel). Le gating est désormais indexé sur le SEUL critère
    // « réparable » : cocher Fixtronix ne doit RIEN changer au bouton actif, et
    // la garde backend de `changeStatusPending2` fait le reste (→ PENDING3).
    // Avant, cocher Fixtronix grisait « Fin diagnostique retour » — c'est le bug
    // signalé sur FT-05.
    { key: '05b', label: 'Retour + Fixtronix COCHÉE + réparable + sans PDR (le coche ne change pas le bouton)', flow: 'retour', rep: true, pdr: false, fix: true, toggles: [['isErrorFromFixtronix', true]], button: BTN.retourFinish, expect: 'PENDING3' },
];

function diId(key: string) {
    return `DI_flowall_${TAG}_${key}`;
}
function idnum(key: string) {
    return `FA-${TAG}-${key}`;
}

async function seedCase(c: Case) {
    const id = diId(c.key);
    const isRetour = c.flow === 'retour';
    const ignoreCount = isRetour ? 1 : 0;
    const comps = c.pdr ? [{ nameComposant: 'Fusible', quantity: 1 }] : [];
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        const now = new Date();
        await db.collection('dis').deleteOne({ _id: id });
        await db.collection('stats').deleteMany({ _idDi: id });
        await db.collection('logsdis').deleteMany({ _idDi: id });
        await db.collection('dis').insertOne({
            _id: id,
            _idnum: idnum(c.key),
            title: `${idnum(c.key)} — ${c.label}`,
            description: c.label,
            status: 'INDIAGNOSTIC',
            ignoreCount,
            can_be_repaired: c.rep,
            contain_pdr: c.pdr,
            array_composants: comps,
            ...(c.fix ? { isErrorFromFixtronix: true } : {}),
            di_category_id: 'CAT-FLOWALL',
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
            _id: `stat-${id}`,
            _idDi: id,
            diRef: id,
            id_tech_diag: TECH_ID,
            id_tech_rep: TECH_ID,
            status: 'INDIAGNOSTIC',
            diag_time: '00:00:00',
            rep_time: '',
            ignoreCount,
            retour_count: ignoreCount,
            pauseLogs: [],
            createdAt: now,
            updatedAt: now,
        });
        if (isRetour) {
            await db.collection('logsdis').insertOne({
                _id: `log-${id}`,
                _idDi: id,
                idIgnore: 1,
                can_be_repaired: c.rep,
                contain_pdr: c.pdr,
                array_composants: comps,
                isErrorFromFixtronix: c.fix,
                createdAt: now,
                updatedAt: now,
            });
        }
    });
    return id;
}

async function dbStatus(id: string): Promise<string | undefined> {
    return withDb(async (db) => {
        const d = await db.collection('dis').findOne({ _id: id });
        return d?.status;
    });
}

/** Tous les statuts par lesquels la DI est réellement passée (hook d'entité). */
async function statusTrail(id: string): Promise<string[]> {
    return withDb(async (db) => {
        const d = await db.collection('dis').findOne({ _id: id });
        const hist = (d?.statusHistory ?? []).map((h: any) => String(h?.status));
        return [...hist, String(d?.status)];
    });
}

async function openDiag(page: Page, num: string) {
    await expect(async () => {
        const row = page.locator('tr', { hasText: num });
        if ((await row.count()) === 0) await page.reload();
        await expect(row.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    await page
        .locator('tr', { hasText: num })
        .first()
        .locator('button:has(.pi-search)')
        .click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({ timeout: 10000 });
}

async function goStep(page: Page, label: string) {
    await page.locator('.sav-stepper__btn', { hasText: label }).click();
}

/**
 * À l'ouverture, les bascules doivent DÉJÀ refléter le scénario seedé — sans
 * aucune manipulation. Verrouille le correctif du préremplissage : les deux
 * `patchValue` utilisaient `di.isPdr || contain_pdr || true`, dont le `|| true`
 * ÉCRASAIT tout `false` persisté, si bien que chaque DI s'ouvrait en Oui/Oui.
 */
async function assertPrefilledToggles(page: Page, c: Case) {
    await goStep(page, 'Validation');

    const rep = page.locator('input[formcontrolname="isReparable"]');
    await expect(rep, '« réparable » préremplie depuis la DI / le cycle').toBeChecked({
        checked: c.rep,
        timeout: 8000,
    });

    // Non réparable ⇒ le toggle PDR est forcé à false ET grisé.
    const pdr = page.locator('input[formcontrolname="isPdr"]');
    await expect(pdr, '« contient des PDR » préremplie').toBeChecked({
        checked: c.rep && c.pdr,
        timeout: 8000,
    });
    if (!c.rep) {
        await expect(pdr, 'PDR grisé quand la DI est non réparable').toBeDisabled();
    }
}

async function setToggle(page: Page, control: string, checked: boolean) {
    const box = page.locator(`input[formcontrolname="${control}"]`);
    await expect(box).toBeVisible({ timeout: 8000 });
    if ((await box.isChecked()) !== checked) await box.click({ force: true });
    await expect(box).toBeChecked({ checked, timeout: 4000 });
}

/**
 * GATING COMPLET des CTA de fin : celui attendu activé, TOUS les autres soit
 * absents du DOM (masqués par `*ngIf`), soit rendus mais désactivés. Sans cette
 * seconde moitié, un bouton actif « en trop » ouvrirait un chemin de routage
 * parallèle sans que rien ne le signale.
 */
async function assertFinishGating(
    page: Page,
    expectedLabel: string,
    isRetour: boolean,
) {
    const cta = (label: string) =>
        page.locator('.actions button', { hasText: label });

    await expect(
        cta(expectedLabel),
        `« ${expectedLabel} » doit être rendu et ACTIVÉ`,
    ).toBeEnabled({ timeout: 8000 });

    if (isRetour) {
        // Flux RETOUR : PLUS AUCUN GRISAGE. Les deux boutons sont cliquables et
        // le BACKEND garantit le bon statut quel que soit celui qu'on presse
        // (backstop non-réparable sur `changeStatusPending2` + routage complet
        // des retours réparables dans `changeStatusTofinsh`). Les cas `…b`
        // ci-dessous prouvent l'équivalence bouton par bouton.
        for (const label of [BTN.retourFinish, BTN.retourSend]) {
            await expect(
                cta(label),
                `« ${label} » doit être cliquable sur un retour`,
            ).toBeEnabled({ timeout: 8000 });
        }
        return;
    }

    // Flux ORIGINAL : l'exclusivité vient des `*ngIf` (« Finir le diagnostic »
    // vs « Terminer (non réparable) »), elle reste vraie.
    for (const other of ALL_BUTTONS.filter((b) => b !== expectedLabel)) {
        const btn = cta(other);
        if ((await btn.count()) === 0) continue; // masqué par *ngIf → conforme
        await expect(
            btn,
            `« ${other} » ne doit PAS être cliquable sur ce cas`,
        ).toBeDisabled();
    }
}

test.afterAll(async () => {
    await withDb(async (db) => {
        for (const col of ['dis', 'stats', 'logsdis', 'notifications']) {
            const field = col === 'dis' ? '_id' : col === 'notifications' ? 'diId' : '_idDi';
            await db.collection(col).deleteMany({ [field]: { $regex: `_flowall_${TAG}_` } });
        }
    });
});

for (const c of CASES) {
    test(`FT-${c.key} — ${c.label} → ${c.expect}`, async ({ page }) => {
        const id = await seedCase(c);
        await page.goto(TECH_LIST);
        await openDiag(page, idnum(c.key));

        // Le scénario doit être en place DÈS l'ouverture ; les `toggles` restants
        // ne sont plus qu'un filet (setToggle est idempotent).
        await assertPrefilledToggles(page, c);
        for (const [ctrl, val] of c.toggles) await setToggle(page, ctrl, val);

        await goStep(page, 'Résumé');
        await assertFinishGating(page, c.button, c.flow === 'retour');

        await page.locator('.actions button', { hasText: c.button }).click();
        await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();

        await expect.poll(() => dbStatus(id), { timeout: 15000 }).toBe(c.expect);
        // Ne doit JAMAIS rester bloqué en diagnostic (le bug FT-06).
        expect(await dbStatus(id)).not.toBe('INDIAGNOSTIC');
    });
}


// ───────────── ÉQUIVALENCE DES DEUX BOUTONS SUR LE FLUX RETOUR ──────────────
/**
 * Le grisage a disparu : sur un retour, le tech peut cliquer l'UN OU L'AUTRE.
 * On rejoue donc les 6 cas retour avec le bouton OPPOSÉ à celui de la matrice
 * ci-dessus et on attend EXACTEMENT le même statut.
 *
 * Sans ces cas, rien ne couvrirait les 4 routes que le grisage masquait :
 *   FT-04/FT-07 par « Envoyer vers finir » clôturaient en IRREPARABLE une DI
 *   RÉPARABLE ; FT-08 idem ; FT-06/FT-09 par « Fin diagnostique retour »
 *   partaient en PENDING2 (facturation) au lieu d'IRREPARABLE.
 */
const RETOUR_CASES = CASES.filter((c) => c.flow === 'retour' && c.key !== '05b');

for (const c of RETOUR_CASES) {
    const other =
        c.button === BTN.retourSend ? BTN.retourFinish : BTN.retourSend;
    test(`FT-${c.key}b — ${c.label} via « ${other} » → ${c.expect} (même statut que l'autre bouton)`, async ({
        page,
    }) => {
        const variant: Case = { ...c, key: `${c.key}b`, button: other };
        const id = await seedCase(variant);
        await page.goto(TECH_LIST);
        await openDiag(page, idnum(variant.key));

        await assertPrefilledToggles(page, variant);
        for (const [ctrl, val] of variant.toggles) await setToggle(page, ctrl, val);

        await goStep(page, 'Résumé');
        await assertFinishGating(page, other, true);

        await page.locator('.actions button', { hasText: other }).click();
        await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();

        await expect
            .poll(() => dbStatus(id), { timeout: 15000 })
            .toBe(variant.expect);
        expect(await dbStatus(id)).not.toBe('INDIAGNOSTIC');
    });
}

// ───────────────────────────── FT-04, 2e saut ────────────────────────────────
/**
 * « MagasinEstimation → PENDING3 (jamais Pricing) ».
 *
 * FT-04 ci-dessus ne prouve que l'ENTRÉE au magasin. La règle argent porte sur
 * la SORTIE : une erreur Fixtronix (notre faute) n'est jamais facturée, donc la
 * DI ne doit toucher NI PENDING2 NI PRICING_DIAG en chemin. On pousse la DI
 * jusqu'au bout avec les vraies mutations et on relit `statusHistory`.
 */
test('FT-04 (2e saut) — sortie magasin d’un retour Fixtronix → PENDING3 sans jamais voir PENDING2/Pricing', async ({
    page,
    request,
}) => {
    const c = CASES.find((x) => x.key === '04')!;
    const id = await seedCase(c);
    await page.goto(TECH_LIST);
    await openDiag(page, idnum('04'));
    await goStep(page, 'Résumé');
    await assertFinishGating(page, BTN.retourFinish, true);
    await page.locator('.actions button', { hasText: BTN.retourFinish }).click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();
    await expect.poll(() => dbStatus(id), { timeout: 15000 }).toBe('MagasinEstimation');

    // Suite serveur-autoritaire : sortie magasin puis poignée de main composants.
    const token = tokenFor('ADMIN_MANAGER');
    const walk: Array<[string, string, string]> = [
        // « Terminer l'estimation » du magasin — c'est CE saut qui partait en PENDING2.
        ['sortie magasin', `changeStatusPending2(_id: "${id}")`, 'CONFIRMATION'],
        ['envoi coordination', `sendComponentToConMagasinForConfirmation(_id: "${id}") { _id status }`, 'CONFIRMATION'],
        ['confirmation coordination', `componentConfirmedFromCoordinator(_id: "${id}") { _id status }`, 'CONFIRMATION'],
        ['fin liste composants', `changeStatusPending3(_id: "${id}")`, 'PENDING3'],
    ];
    for (const [label, mut, _expected] of walk) {
        const r = await gqlPost(request, `mutation { ${mut} }`, token);
        expect(r.errors, `${label} — ${r.errorText}`).toBeNull();
    }

    expect(await dbStatus(id), 'la DI doit atteindre PENDING3').toBe('PENDING3');
    // Le devis coordinatrice reste obligatoire avant l'envoi en réparation.
    const di: any = await withDb((db) =>
        db.collection('dis').findOne({ _id: id }),
    );
    expect(di?.needsDevisBeforeRepair).toBe(true);

    // LA règle : jamais facturé.
    const trail = await statusTrail(id);
    for (const billing of ['PENDING2', 'PRICING_DIAG', 'PRICING']) {
        expect(trail, `erreur Fixtronix passée par ${billing} : ${trail.join(' → ')}`)
            .not.toContain(billing);
    }
});

// ───────────────────────────────── FT-BL ─────────────────────────────────────
/**
 * « Réparée + attente BL → WAITING_BL ».
 *
 * La fin de réparation ne clôture plus directement : elle ouvre la chaîne de
 * clôture documentaire (WAITING_BL → WAITING_FACTURE → FINISHED, pilotée par les
 * uploads). Sans BL ni facture seedés, la cascade ne doit PAS avancer.
 */
test('FT-BL — « Fin réparation » → WAITING_BL (pas de cascade sans BL ni facture)', async ({
    page,
}) => {
    const id = `DI_flowall_${TAG}_bl`;
    const num = `FA-${TAG}-BL`;
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        const now = new Date();
        await db.collection('dis').deleteOne({ _id: id });
        await db.collection('stats').deleteMany({ _idDi: id });
        await db.collection('dis').insertOne({
            _id: id,
            _idnum: num,
            title: `${num} — Réparée, attente BL`,
            description: 'FT-BL',
            status: 'INREPARATION',
            ignoreCount: 0,
            can_be_repaired: true,
            contain_pdr: true,
            array_composants: [{ nameComposant: 'Fusible', quantity: 1, isUpdated: false }],
            di_category_id: 'CAT-FLOWALL',
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
            _id: `stat-${id}`,
            _idDi: id,
            diRef: id,
            id_tech_diag: TECH_ID,
            id_tech_rep: TECH_ID,
            status: 'INREPARATION',
            diag_time: '00:05:00',
            rep_time: '00:00:00',
            ignoreCount: 0,
            retour_count: 0,
            pauseLogs: [],
            createdAt: now,
            updatedAt: now,
        });
    });

    await page.goto(TECH_LIST);
    await expect(async () => {
        const row = page.locator('tr', { hasText: num });
        if ((await row.count()) === 0) await page.reload();
        await expect(row.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 45000 });
    await page
        .locator('tr', { hasText: num })
        .first()
        .locator('button:has(.pi-wrench)')
        .click();
    await expect(page.locator('.sav-diag-header')).toBeVisible({ timeout: 10000 });

    await page
        .locator('textarea[formcontrolname="worksDone"]')
        .fill('Soudure refaite, composant remplacé, nettoyage carte.');
    await page
        .locator('[aria-label="Réparation réussie"] button:has-text("Oui")')
        .click();
    await page
        .locator('[aria-label="Tests validés"] button:has-text("Oui")')
        .click();
    await page.locator('.sav-diag-modal__nav-btn--primary').click(); // → Résumé

    const finishBtn = page.locator('.cta__btn');
    await expect(finishBtn).toBeEnabled({ timeout: 8000 });
    await finishBtn.click();

    await expect(page.locator('.p-toast-message-error')).toHaveCount(0);
    await expect.poll(() => dbStatus(id), { timeout: 15000 }).toBe('WAITING_BL');
    // Sans document, la chaîne documentaire ne doit PAS cascader.
    expect(await dbStatus(id)).not.toBe('WAITING_FACTURE');
    expect(await dbStatus(id)).not.toBe('FINISHED');
});
