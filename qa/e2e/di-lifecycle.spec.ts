import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { tokenFor } from '../utils/auth';
import { gqlPost } from '../utils/graphql';
import { withDb } from '../utils/mongo';

/**
 * DI lifecycle audit — drive a DI CREATED → FINISHED through every workflow
 * transition and ASSERT the status after each step, plus edge probes
 * (negative/zero price, out-of-sequence transition, double-submit).
 *
 * The cross-role routing transitions are driven via their GraphQL mutations
 * (the workflow engine) so the chain is deterministic; the per-step status is
 * read back from getDiById. Records ✅/❌ per step and the breakpoint.
 *
 * x-test-run:1 (via gqlPost) → logged server-side, never pushed to Discord.
 * All seeded docs are hard-deleted in afterAll.
 */

const TECH_ID = '69fb49a8fbdfcb7ca81bed0e';
const TAG = Date.now().toString(36);
const diId = `DI_life_${TAG}`;
const statId = `STAT_life_${TAG}`;

type Step = { step: string; expected: string; got?: string; ok: boolean; note?: string };
const results: Step[] = [];

let token = '';

async function status(api: APIRequestContext): Promise<string | undefined> {
    const r = await gqlPost(api, `{ getDiById(_id: "${diId}") { di { _id status price final_price } } }`, token);
    return r.data?.getDiById?.di?.status;
}

async function transition(
    api: APIRequestContext,
    label: string,
    mutation: string,
    expected: string,
): Promise<boolean> {
    const r = await gqlPost(api, mutation, token);
    const errs = (r.errors ?? []).map((e: any) => `${e.extensions?.code ?? '?'}: ${e.message}`);
    const is500 = errs.some((e) => /INTERNAL_SERVER_ERROR/.test(e));
    const got = await status(api);
    const ok = got === expected && errs.length === 0;
    results.push({
        step: label,
        expected,
        got,
        ok,
        note: errs.length ? `errors=[${errs.join(' | ')}]${is500 ? ' ⚠500' : ''}` : undefined,
    });
    return ok;
}

test.beforeAll(async () => {
    token = tokenFor('ADMIN_MANAGER');
    await withDb(async (db) => {
        const client = await db.collection('clients').findOne({ isDeleted: { $ne: true } });
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: `LIFE-${TAG}`,
            title: 'QA Lifecycle',
            description: 'full lifecycle audit',
            status: 'CREATED',
            can_be_repaired: true,
            contain_pdr: false, // no parts → diagnostic goes straight to PENDING2
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
    // Print the per-step table for the audit.
    const table = results
        .map(
            (r) =>
                `${r.ok ? '✅' : '❌'} ${r.step.padEnd(34)} expected=${(r.expected || '').padEnd(16)} got=${String(r.got).padEnd(16)}${r.note ? ' ' + r.note : ''}`,
        )
        .join('\n');
    console.log('\n──────── DI LIFECYCLE STATUS TABLE ────────\n' + table + '\n');
});

test('drive CREATED → FINISHED, asserting status at every transition', async ({ request }) => {
    const M = (op: string) => `mutation { ${op} }`;

    // The happy-path chain. Each returns whether the expected status was reached.
    const chain: Array<[string, string, string]> = [
        ['manager_Pending1', M(`manager_Pending1(_id: "${diId}") { _id status }`), 'PENDING1'],
        ['coordinatorSendingDiDiag', M(`coordinatorSendingDiDiag(_idDI: "${diId}") { _id status }`), 'DIAGNOSTIC'],
        ['changeStatusInDiagnostic', M(`changeStatusInDiagnostic(_id: "${diId}")`), 'INDIAGNOSTIC'],
        ['magasinTech_Pending2', M(`magasinTech_Pending2(_id: "${diId}") { _id status }`), 'PENDING2'],
        ['changeStatusPricing', M(`changeStatusPricing(_id: "${diId}")`), 'PRICING'],
        ['changeStatusNegociate1', M(`changeStatusNegociate1(_id: "${diId}")`), 'NEGOTIATION1'],
        ['managerAdminManager_Pending3', M(`managerAdminManager_Pending3(_id: "${diId}") { _id status }`), 'PENDING3'],
        ['changeStatusRepaire', M(`changeStatusRepaire(_id: "${diId}")`), 'REPARATION'],
        ['changeStatusInRepair', M(`changeStatusInRepair(_id: "${diId}")`), 'INREPARATION'],
        ['changestatusToFinishReparation', M(`changestatusToFinishReparation(_id: "${diId}") { _id status }`), 'FINISHED'],
    ];

    let broke = false;
    for (const [label, mutation, expected] of chain) {
        const ok = await transition(request, label, mutation, expected);
        if (!ok) {
            broke = true;
            break; // stop the happy path at the first rupture
        }
    }

    const finalStatus = await status(request);
    console.log('FINAL STATUS:', finalStatus, '| broke at:', broke ? results[results.length - 1].step : 'none');

    // The headline assertion — did we reach FINISHED?
    expect(finalStatus, `lifecycle ended at ${finalStatus}; see status table in afterAll`).toBe('FINISHED');
});

test('EDGE: affectinitialPrice accepts negative / zero price?', async ({ request }) => {
    // Probe price validation independently (does not need the chain).
    const neg = await gqlPost(request, `mutation { affectinitialPrice(_id: "${diId}", price: -500) }`, token);
    const zero = await gqlPost(request, `mutation { affectinitialPrice(_id: "${diId}", price: 0) }`, token);
    const after = await gqlPost(request, `{ getDiById(_id: "${diId}") { di { price } } }`, token);
    console.log(
        'PRICE PROBE → negative result:',
        JSON.stringify(neg.data ?? neg.errors),
        '| zero result:',
        JSON.stringify(zero.data ?? zero.errors),
        '| stored price:',
        after.data?.getDiById?.di?.price,
    );
    // Not a hard assert (documenting behaviour): flag if a negative price was accepted.
    const negativeAccepted = neg.errors?.length ? false : after.data?.getDiById?.di?.price < 0;
    expect(
        negativeAccepted,
        'negative initial price was accepted and stored (no validation)',
    ).toBeFalsy();
});

// M1 — out-of-sequence transitions must be REFUSED cleanly (BAD_REQUEST),
// WITHOUT mutating the DI and WITHOUT a 500. One case per illegal jump.
const ILLEGAL: Array<{ label: string; from: string; mutation: (id: string) => string }> = [
    {
        label: 'CREATED → FINISHED',
        from: 'CREATED',
        mutation: (id) => `mutation { changestatusToFinishReparation(_id: "${id}") { _id status } }`,
    },
    {
        label: 'PENDING1 → FINISHED',
        from: 'PENDING1',
        mutation: (id) => `mutation { changestatusToFinishReparation(_id: "${id}") { _id status } }`,
    },
    {
        label: 'DIAGNOSTIC → REPARATION',
        from: 'DIAGNOSTIC',
        mutation: (id) => `mutation { changeStatusRepaire(_id: "${id}") }`,
    },
    {
        label: 'CREATED → PRICING',
        from: 'CREATED',
        mutation: (id) => `mutation { changeStatusPricing(_id: "${id}") }`,
    },
];

for (const c of ILLEGAL) {
    test(`GUARD: ${c.label} is refused (BAD_REQUEST, DI unchanged, no 500)`, async ({ request }) => {
        const tmpId = `DI_ill_${TAG}_${c.from}`;
        await withDb(async (db) => {
            await db.collection('dis').insertOne({
                _id: tmpId,
                _idnum: `ILL-${TAG}-${c.from}`,
                title: 'QA illegal-jump',
                status: c.from,
                isDeleted: false,
                array_composants: [],
                current_roles: ['Manager'],
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        });
        const r = await gqlPost(request, c.mutation(tmpId), token);
        const after = (
            await gqlPost(request, `{ getDiById(_id: "${tmpId}") { di { status } } }`, token)
        ).data?.getDiById?.di?.status;
        const code = r.errors?.[0]?.extensions?.code;
        await withDb(async (db) => {
            await db.collection('dis').deleteOne({ _id: tmpId });
        });

        expect(r.httpStatus, 'transport stays 200').toBe(200);
        expect(code, `${c.label}: expected BAD_REQUEST`).toBe('BAD_REQUEST');
        expect(code, 'no 500').not.toBe('INTERNAL_SERVER_ERROR');
        expect(after, `${c.label}: DI must be UNCHANGED (still ${c.from})`).toBe(c.from);
    });
}
