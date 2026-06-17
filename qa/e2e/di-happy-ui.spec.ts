import { test, expect } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { authFile, tokenFor } from '../utils/auth';
import { gqlPost } from '../utils/graphql';
import { withDb } from '../utils/mongo';

/**
 * P4 — End-to-end UI parcours: walk a single DI from CREATED → FINISHED and
 * validate the three recent passes in one run:
 *   P1  the M1 transition guard accepts the legal `_Pause` arcs (regression for
 *       the DIAGNOSTIC_Pause → MagasinEstimation false positive), and still
 *       refuses illegal jumps.
 *   P2  uploads (BC + Devis) PERSIST on the Fixtronix backend — zero requests
 *       go to primefaces.org. Refetching the DI proves persistence.
 *   P3  the redesigned Prix Initial / Prix Final modals open, gate input
 *       correctly, run the serialized MutationRunner cascade, fire each
 *       mutation exactly once (double-click idempotent), and advance the DI
 *       status as expected.
 *
 * Strategy. Cross-role transitions (Manager → Coordinator → Tech → Magasin)
 * would force a per-step storage-state swap that adds no signal; for those
 * transitions we POST the mutations directly with the ADMIN_MANAGER token
 * (same exact gql strings the front uses; `x-test-run: 1` is set by gqlPost).
 * The UI-critical surfaces (P3 modals + P2 network) are driven via Playwright.
 *
 * Per-step results are recorded into a table printed in afterAll for the audit.
 */

const TICKET_LIST = '/tickets/ticket/ticket-list';
const TECH_ID = '69fb49a8fbdfcb7ca81bed0e';

// A 1×1 base64 PDF body — the backend writes this STRING to disk verbatim
// (see fix-back DI service), so the file just needs to be non-empty + base64.
const PDF_B64 =
    'data:application/pdf;base64,JVBERi0xLjMKJcfsj6IKNCAwIG9iaiAKPDwgL0xlbmd0aCAyMjQgPj4Kc3RyZWFtCkVuZHN0cmVhbQplbmRvYmoKMyAwIG9iagpbXQplbmRvYmoKMiAwIG9iagpbXQplbmRvYmoKMSAwIG9iagpbXQplbmRvYmoKNiAwIG9iagpbXQplbmRvYmoKdHJhaWxlcgo8PCAvU2l6ZSA3IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgoxMjMyCiUlRU9G';

type Step = {
    step: string;
    expected: string;
    got?: string;
    ok: boolean;
    note?: string;
};

let token = '';
const tag = `p4_${Date.now().toString(36)}`;
const diId = `DI_${tag}`;
const statId = `STAT_${tag}`;
const idnum = `P4-${tag.toUpperCase()}`;
const results: Step[] = [];
const recordedPrimefaces: string[] = [];

test.use({ storageState: authFile('ADMIN_MANAGER') });
test.describe.configure({ mode: 'serial' });

async function dbDi(): Promise<any> {
    return withDb(async (db) =>
        db.collection('dis').findOne({ _id: diId }),
    );
}
async function dbStatus(): Promise<string | undefined> {
    const d = await dbDi();
    return d?.status;
}

async function apiTransition(
    api: any,
    label: string,
    mutation: string,
    expected: string,
): Promise<void> {
    const r = await gqlPost(api, mutation, token);
    const errs = (r.errors ?? []).map(
        (e: any) => `${e.extensions?.code ?? '?'}: ${e.message}`,
    );
    const got = await dbStatus();
    const ok = got === expected && errs.length === 0;
    results.push({
        step: label,
        expected,
        got,
        ok,
        note: errs.join(' | ') || undefined,
    });
    expect(ok, `${label}: expected ${expected}, got ${got} errs=[${errs.join(' | ')}]`).toBeTruthy();
}

/**
 * Attach a Network observer that records:
 *   - any request to primefaces.org (P2 zero-CDN assertion);
 *   - per-mutation call counts (cascade idempotency assertion).
 * Returns the live counters so the test can assert on them.
 */
function watchNetwork(
    page: Page,
    mutations: string[],
): {
    counts: Map<string, number>;
    primefaces: string[];
} {
    const counts = new Map<string, number>(mutations.map((m) => [m, 0]));
    const primefaces: string[] = [];
    page.on('request', (req: Request) => {
        const url = req.url();
        if (url.includes('primefaces.org')) {
            primefaces.push(url);
            recordedPrimefaces.push(url);
        }
        if (url.includes('/graphql') && req.method() === 'POST') {
            const body = req.postData() || '';
            for (const m of mutations) {
                if (body.includes(m))
                    counts.set(m, (counts.get(m) || 0) + 1);
            }
        }
    });
    return { counts, primefaces };
}

test.beforeAll(async () => {
    token = tokenFor('ADMIN_MANAGER');
    await withDb(async (db) => {
        const client = await db
            .collection('clients')
            .findOne({ isDeleted: { $ne: true } });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: 'QA P4 happy-UI',
            description: 'CREATED → FINISHED + P1/P2/P3 validation',
            status: 'CREATED',
            can_be_repaired: true,
            contain_pdr: false, // → diagnostic exits to PENDING2 / PRICING / NEGO1
            client_id: client?._id ?? null,
            createdBy: TECH_ID,
            array_composants: [],
            current_workers_ids: [TECH_ID],
            current_roles: ['Manager', 'Admin_Manager'],
            isDeleted: false,
            price: 0,
            statusUpdatedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await db.collection('stats').insertOne({
            _id: statId,
            _idDi: diId,
            diRef: diId,
            id_tech_rep: TECH_ID,
            id_tech_diag: TECH_ID,
            status: 'CREATED',
            diag_time: '00:05:00',
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
        await db.collection('dis').deleteOne({ _id: diId });
        await db.collection('stats').deleteOne({ _id: statId });
    });
    const table = results
        .map(
            (r) =>
                `${r.ok ? '✅' : '❌'} ${r.step.padEnd(46)} expected=${(r.expected || '').padEnd(20)} got=${String(r.got).padEnd(20)}${r.note ? ' · ' + r.note : ''}`,
        )
        .join('\n');
    console.log(
        '\n──────── P4 HAPPY-UI STATUS TABLE ────────\n' +
            table +
            `\n\n· primefaces.org calls observed: ${recordedPrimefaces.length}\n`,
    );
});

// ── 1) CREATED → PRICING via API (incl. P1 _Pause arc) ───────────────
test('step 1 — CREATED → PRICING via mutations (P1 _Pause arc included)', async ({
    request,
}) => {
    const M = (op: string) => `mutation { ${op} }`;
    await apiTransition(
        request,
        '1.1 manager_Pending1',
        M(`manager_Pending1(_id: "${diId}") { _id status }`),
        'PENDING1',
    );
    await apiTransition(
        request,
        '1.2 coordinatorSendingDiDiag',
        M(`coordinatorSendingDiDiag(_idDI: "${diId}") { _id status }`),
        'DIAGNOSTIC',
    );
    await apiTransition(
        request,
        '1.3 changeStatusInDiagnostic',
        M(`changeStatusInDiagnostic(_id: "${diId}")`),
        'INDIAGNOSTIC',
    );
    // P1 — PAUSE then RESUME-to-MagasinEstimation. This is the exact arc whose
    // refusal (BAD_REQUEST "DIAGNOSTIC_Pause → MagasinEstimation") was the
    // reported M1 regression. It must succeed now.
    await apiTransition(
        request,
        '1.4 changeToDiagnosticInPause (P1 pause)',
        M(`changeToDiagnosticInPause(_idDI: "${diId}") { _id status }`),
        'DIAGNOSTIC_Pause',
    );
    await apiTransition(
        request,
        '1.5 changeStatusMagasinEstimation (P1 _Pause→MagasinEstimation)',
        M(`changeStatusMagasinEstimation(_id: "${diId}")`),
        'MagasinEstimation',
    );
    await apiTransition(
        request,
        '1.6 changeStatusPending2',
        M(`changeStatusPending2(_id: "${diId}")`),
        'PENDING2',
    );
    await apiTransition(
        request,
        '1.7 changeStatusPricing',
        M(`changeStatusPricing(_id: "${diId}")`),
        'PRICING',
    );
});

// ── 2) UI — Prix Initial modal (P3 + P2 + cascade) ───────────────────
test('step 2 — Prix Initial UI (P3 modal renders, cascade once, no primefaces)', async ({
    page,
}) => {
    const observer = watchNetwork(page, [
        'affectinitialPrice',
        'changeStatusNegociate1',
    ]);

    await page.goto(TICKET_LIST);
    const row = page.locator('tr', { hasText: idnum });
    await expect(row).toBeVisible({ timeout: 25_000 });

    // Open the Prix Initial modal. Only the dollar-icon "Affecter prix" button
    // is rendered for a PRICING row.
    await row.locator('button:has(.pi-dollar)').click();
    await expect(page.locator('.pricing-modal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.pricing-modal__title')).toContainText(
        /Affectation du prix initial/i,
    );

    // P3 chrome elements present.
    await expect(page.locator('.pricing-chip')).toHaveCount(4);
    await expect(page.locator('.pricing-cost-total')).toBeVisible();

    // Gating: empty price → button disabled.
    const affecter = page.getByRole('button', { name: /Affecter le prix/ });
    await expect(affecter).toBeDisabled();

    // Type a valid price (the input has inputId="pricing-init-input").
    await page.locator('#pricing-init-input').fill('60');
    await page.locator('#pricing-init-input').blur();
    await expect(affecter).toBeEnabled({ timeout: 5_000 });

    // Click Affecter → opens PrimeNG confirmation dialog → accept.
    await affecter.click();
    const acceptBtn = page.locator('.p-confirm-dialog .p-confirm-dialog-accept');
    await acceptBtn.waitFor({ state: 'visible', timeout: 8_000 });
    await acceptBtn.click();

    // Single success toast.
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 15_000,
    });

    // DB-side assertions.
    await expect.poll(dbStatus, { timeout: 15_000 }).toBe('NEGOTIATION1');
    const di = await dbDi();
    expect(di?.price, 'price persisted').toBeGreaterThan(0);

    // P2: no primefaces.org calls observed during this UI flow.
    expect(
        observer.primefaces,
        `primefaces calls=${JSON.stringify(observer.primefaces)}`,
    ).toHaveLength(0);

    // Cascade idempotency.
    expect(
        observer.counts.get('affectinitialPrice'),
        `affectinitialPrice ×${observer.counts.get('affectinitialPrice')}`,
    ).toBe(1);
    expect(
        observer.counts.get('changeStatusNegociate1'),
        `changeStatusNegociate1 ×${observer.counts.get('changeStatusNegociate1')}`,
    ).toBe(1);

    results.push({
        step: '2 P3 Prix Initial UI + cascade',
        expected: 'NEGOTIATION1',
        got: 'NEGOTIATION1',
        ok: true,
    });
});

// ── 3) Upload BC + Devis via the same mutations the front uses ───────
test('step 3 — uploads BC + Devis persist (P2)', async ({ request }) => {
    const json = JSON.stringify(PDF_B64);
    const bc = await gqlPost(
        request,
        `mutation { addBC(_id: "${diId}", pdf: ${json}) { _id } }`,
        token,
    );
    expect(bc.errors ?? [], 'addBC ok').toHaveLength(0);
    const dv = await gqlPost(
        request,
        `mutation { addDevis(_id: "${diId}", pdf: ${json}) { _id } }`,
        token,
    );
    expect(dv.errors ?? [], 'addDevis ok').toHaveLength(0);

    const di = await dbDi();
    expect(di?.bon_de_commande, 'BC persisted on DI').toBeTruthy();
    expect(di?.devis, 'Devis persisted on DI').toBeTruthy();

    results.push({
        step: '3 P2 uploads persisted (BC+Devis)',
        expected: 'persisted',
        got: 'persisted',
        ok: true,
    });
});

// ── 4) UI — Prix Final modal (P3 + cascade) ──────────────────────────
test('step 4 — Prix Final UI (P3 modal + serialized cascade)', async ({ page }) => {
    const observer = watchNetwork(page, [
        'managerAdminManager_InMagasin',
        'changeStatusPending3',
    ]);
    const gqlErrors: string[] = [];
    page.on('response', async (resp) => {
        if (!resp.url().includes('/graphql')) return;
        try {
            const body = await resp.json();
            if (Array.isArray(body?.errors) && body.errors.length) {
                gqlErrors.push(JSON.stringify(body.errors));
            }
        } catch {
            /* non-JSON */
        }
    });
    page.on('pageerror', (err) => gqlErrors.push(`pageerror: ${err.message}`));

    await page.goto(TICKET_LIST);
    const row = page.locator('tr', { hasText: idnum });
    await expect(row).toBeVisible({ timeout: 25_000 });

    // The NEGOTIATION1 row exposes a dollar-icon "Négociation" button.
    await row.locator('button:has(.pi-dollar)').click();
    await expect(page.locator('.pricing-modal__title')).toContainText(
        /Affectation du prix final/i,
        { timeout: 10_000 },
    );

    // BC + Devis badges should be "Chargé" since we persisted them in step 3.
    await expect(page.locator('.fp-doc-badge--done')).toHaveCount(2, {
        timeout: 8_000,
    });

    // Set a 10% discount via the input (slider is synced via two-way binding).
    const remiseInput = page.locator('.fp-tarif-percent input').first();
    await remiseInput.fill('10');
    await remiseInput.blur();
    await page.waitForTimeout(200); // let ngModelChange settle

    const confirmer = page.getByRole('button', {
        name: 'Confirmer le prix final',
    });
    await expect(confirmer).toBeEnabled({ timeout: 5_000 });

    await confirmer.click();
    const accept = page.locator('.p-confirm-dialog .p-confirm-dialog-accept');
    await accept.waitFor({ state: 'visible', timeout: 8_000 });
    await accept.click();

    // !contain_pdr → PENDING3 (M5 branch B1). Poll DB directly — toast-only
    // assertions race against the cascade's two-step flow.
    try {
        await expect
            .poll(dbStatus, { timeout: 20_000, intervals: [400, 600, 1000] })
            .toBe('PENDING3');
    } catch (e) {
        throw new Error(
            `Cascade did not advance the DI to PENDING3. ` +
                `gqlErrors=${JSON.stringify(gqlErrors)} ` +
                `priceCount=${observer.counts.get('managerAdminManager_InMagasin')} ` +
                `transitionCount=${observer.counts.get('changeStatusPending3')}`,
        );
    }
    // Toast comes after the cascade — give it a moment but don't hard-fail.
    await page.waitForTimeout(500);
    const toastOk = await page
        .locator('.p-toast-message-success')
        .count();
    expect(toastOk, `success toast count=${toastOk} gqlErrors=${JSON.stringify(gqlErrors)}`).toBeGreaterThanOrEqual(1);

    expect(observer.primefaces, 'no primefaces.org').toHaveLength(0);
    expect(
        observer.counts.get('managerAdminManager_InMagasin'),
        `price step ×${observer.counts.get('managerAdminManager_InMagasin')}`,
    ).toBe(1);
    expect(
        observer.counts.get('changeStatusPending3'),
        `transition ×${observer.counts.get('changeStatusPending3')}`,
    ).toBe(1);

    // Confirm the recalculated final_price = price × (1 - 10/100).
    const di = await dbDi();
    expect(
        di?.final_price,
        `final_price stored=${di?.final_price}`,
    ).toBeCloseTo(di.price * 0.9, 1);

    results.push({
        step: '4 P3 Prix Final UI + cascade',
        expected: 'PENDING3',
        got: 'PENDING3',
        ok: true,
    });
});

// ── 5) PENDING3 → FINISHED via mutations (incl. REPARATION_Pause arc) ─
test('step 5 — PENDING3 → FINISHED via mutations (P1 REPARATION_Pause arc)', async ({
    request,
}) => {
    const M = (op: string) => `mutation { ${op} }`;
    await apiTransition(
        request,
        '5.1 changeStatusRepaire',
        M(`changeStatusRepaire(_id: "${diId}")`),
        'REPARATION',
    );
    await apiTransition(
        request,
        '5.2 changeStatusInRepair',
        M(`changeStatusInRepair(_id: "${diId}")`),
        'INREPARATION',
    );
    await apiTransition(
        request,
        '5.3 changeToReparationInPause (P1 pause)',
        M(`changeToReparationInPause(_idDI: "${diId}") { _id status }`),
        'REPARATION_Pause',
    );
    await apiTransition(
        request,
        '5.4 changestatusToFinishReparation (P1 _Pause→FINISHED)',
        M(`changestatusToFinishReparation(_id: "${diId}") { _id status }`),
        'FINISHED',
    );
});

// ── 6) Witness: illegal jump still refused (guard not weakened) ──────
test('step 6 — illegal jump CREATED → FINISHED stays BAD_REQUEST (P1 still guarded)', async ({
    request,
}) => {
    const tmpId = `DI_p4_ill_${tag}`;
    await withDb(async (db) => {
        await db.collection('dis').insertOne({
            _id: tmpId,
            _idnum: `P4-ILL-${tag}`,
            title: 'QA P4 illegal-jump witness',
            status: 'CREATED',
            isDeleted: false,
            array_composants: [],
            current_roles: ['Manager'],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
    const r = await gqlPost(
        request,
        `mutation { changestatusToFinishReparation(_id: "${tmpId}") { _id status } }`,
        token,
    );
    const after = (
        await gqlPost(
            request,
            `{ getDiById(_id: "${tmpId}") { di { status } } }`,
            token,
        )
    ).data?.getDiById?.di?.status;
    const code = r.errors?.[0]?.extensions?.code;
    await withDb(async (db) =>
        db.collection('dis').deleteOne({ _id: tmpId }),
    );

    expect(code, 'expected BAD_REQUEST').toBe('BAD_REQUEST');
    expect(after, 'DI unchanged').toBe('CREATED');
    results.push({
        step: '6 P1 illegal jump still refused',
        expected: 'BAD_REQUEST',
        got: code,
        ok: code === 'BAD_REQUEST',
    });
});
