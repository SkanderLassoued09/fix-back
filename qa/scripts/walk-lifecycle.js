/**
 * Marche complète du cycle de vie d'une DI — « comme un utilisateur simple ».
 *
 * Chaque saut de statut est déclenché par la VRAIE mutation GraphQL, avec le
 * jeton du RÔLE qui la déclenche dans l'app (Manager, Coordinator/COORDIANTOR,
 * Tech, Magasin, Admin_Manager…) — pas le god-mode admin. Après chaque saut on
 * relit le statut et on note ✅/❌ + l'erreur serveur. En cas d'échec, on force
 * le statut en base vers l'attendu pour tester la transition SUIVANTE depuis sa
 * bonne source (couverture de TOUS les statuts, même après une rupture).
 *
 *   MONGO_DB=fixtronixproddb node scripts/walk-lifecycle.js
 */
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const GRAPHQL_URL = (process.env.API_URL ?? 'http://localhost:3000') + '/graphql';

const ID = 'DI_walk_manual';
const STAT = 'stat-DI_walk_manual';
const TECH = '6623d4fea953a0ebca67e7db';

// Jeton par rôle (depuis les storageState .auth).
function tok(role) {
    const st = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '.auth', role + '.json'), 'utf8'),
    );
    return (st.origins?.[0]?.localStorage || []).find((e) => e.name === 'token')?.value;
}
const TOKENS = {};
for (const r of ['MANAGER', 'COORDINATOR', 'TECH', 'MAGASIN', 'ADMIN_MANAGER', 'ADMIN_TECH'])
    TOKENS[r] = tok(r);

// Un data-URL PDF minimal (le service décode base64.split(',')[1]).
const PDF =
    'data:application/pdf;base64,JVBERi0xLjEKJcKlwrHDqwoxIDAgb2JqCjw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+CmVuZG9iagoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvS2lkc1szIDAgUl0vQ291bnQgMT4+CmVuZG9iagozIDAgb2JqCjw8L1R5cGUvUGFnZS9QYXJlbnQgMiAwIFI+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4KJSVFT0Y=';

async function gql(token, query) {
    const resp = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-test-run': '1',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query }),
    });
    const body = await resp.json().catch(() => ({}));
    return { data: body.data ?? null, errors: body.errors ?? null };
}

let db, client;
async function statusOf() {
    const r = await gql(
        TOKENS.ADMIN_MANAGER,
        `{ getDiById(_id: "${ID}") { di { status } } }`,
    );
    return r.data?.getDiById?.di?.status;
}
async function forceStatus(s) {
    await db.collection('dis').updateOne({ _id: ID }, { $set: { status: s } });
    await db.collection('stats').updateMany({ _idDi: ID }, { $set: { status: s } });
}

// [label, roleKey, mutationString, expectedStatus]
const CHAIN = [
    ['manager_Pending1', 'MANAGER', `manager_Pending1(_id:"${ID}"){_id status}`, 'PENDING1'],
    ['coordinatorSendingDiDiag', 'COORDINATOR', `coordinatorSendingDiDiag(_idDI:"${ID}"){_id status}`, 'DIAGNOSTIC'],
    ['changeStatusInDiagnostic', 'TECH', `changeStatusInDiagnostic(_id:"${ID}")`, 'INDIAGNOSTIC'],
    ['changeStatusMagasinEstimation', 'TECH', `changeStatusMagasinEstimation(_id:"${ID}")`, 'MagasinEstimation'],
    ['magasinTech_Pending2', 'MAGASIN', `magasinTech_Pending2(_id:"${ID}"){_id status}`, 'PENDING2'],
    ['changeStatusPricing', 'COORDINATOR', `changeStatusPricing(_id:"${ID}")`, 'PRICING_DIAG'],
    ['changeStatusNegociate1', 'ADMIN_MANAGER', `changeStatusNegociate1(_id:"${ID}")`, 'WAITING_DEVIS'],
    ['addDevis (upload Drive)', 'MANAGER', `addDevis(_id:"${ID}",pdf:"${PDF}"){_id status}`, 'WAITING_BC'],
    ['addBC (upload Drive)', 'MANAGER', `addBC(_id:"${ID}",pdf:"${PDF}"){_id status}`, 'CONFIRMATION'],
    ['sendComponentToConMagasin…', 'MAGASIN', `sendComponentToConMagasinForConfirmation(_id:"${ID}"){_id status}`, 'ATTENTE_CONFIRMATION_COORDINATION'],
    ['componentConfirmedFromCoord', 'COORDINATOR', `componentConfirmedFromCoordinator(_id:"${ID}"){_id status}`, 'MAGASIN_FINALISATION'],
    ['changeStatusPending3 (fin liste)', 'MAGASIN', `changeStatusPending3(_id:"${ID}")`, 'PENDING3'],
    ['changeStatusRepaire', 'COORDINATOR', `changeStatusRepaire(_id:"${ID}")`, 'REPARATION'],
    ['changeStatusInRepair', 'TECH', `changeStatusInRepair(_id:"${ID}")`, 'INREPARATION'],
    ['changestatusToFinishReparation', 'TECH', `changestatusToFinishReparation(_id:"${ID}"){_id status}`, 'WAITING_BL'],
    ['addBl (upload Drive)', 'MANAGER', `addBl(_id:"${ID}",pdf:"${PDF}"){_id status}`, 'WAITING_FACTURE'],
    ['addFacture (upload Drive)', 'MANAGER', `addFacture(_id:"${ID}",pdf:"${PDF}"){_id status}`, 'FINISHED'],
    ['changeStatusRetour1', 'MANAGER', `changeStatusRetour1(_id:"${ID}",reason:"QA walk")`, 'RETOUR1'],
    ['changeStatusRetour2', 'MANAGER', `changeStatusRetour2(_id:"${ID}",reason:"QA walk")`, 'RETOUR2'],
    ['changeStatusRetour3', 'MANAGER', `changeStatusRetour3(_id:"${ID}",reason:"QA walk")`, 'RETOUR3'],
];

(async () => {
    client = new MongoClient(MONGO_URL);
    await client.connect();
    db = client.db(MONGO_DB);
    const now = new Date();

    // Seed frais en CREATED, réparable, AVEC PDR + composants (⇒ passe par le
    // magasin), assigné au vrai tech.
    await db.collection('dis').deleteOne({ _id: ID });
    await db.collection('stats').deleteMany({ _idDi: ID });
    const someClient = await db.collection('clients').findOne({ isDeleted: { $ne: true } });
    await db.collection('dis').insertOne({
        _id: ID, _idnum: 'WALK-001', title: 'SEED — walk lifecycle',
        description: 'walk every status as real roles',
        status: 'CREATED', can_be_repaired: true, contain_pdr: true,
        diagnosticPayant: true,
        array_composants: [{ nameComposant: 'Fusible', quantity: 1 }],
        client_id: someClient?._id ?? null, createdBy: TECH,
        current_workers_ids: [TECH], current_roles: ['Manager', 'Admin_Manager'],
        ignoreCount: 0, price: 200, isDeleted: false,
        statusUpdatedAt: now, createdAt: now, updatedAt: now,
    });
    await db.collection('stats').insertOne({
        _id: STAT, _idDi: ID, diRef: ID, id_tech_diag: TECH, id_tech_rep: TECH,
        status: 'CREATED', diag_time: '00:05:00', rep_time: '', ignoreCount: 0,
        retour_count: 0, pauseLogs: [], createdAt: now, updatedAt: now,
    });

    const rows = [];
    for (const [label, role, mutation, expected] of CHAIN) {
        const from = await statusOf();
        const r = await gql(TOKENS[role], `mutation { ${mutation} }`);
        const got = await statusOf();
        const errs = (r.errors ?? []).map(
            (e) => `${e.extensions?.code ?? '?'}: ${e.message}`,
        );
        const is500 = errs.some((e) => /INTERNAL_SERVER_ERROR/.test(e));
        const ok = got === expected && errs.length === 0;
        let forced = false;
        if (got !== expected) {
            await forceStatus(expected); // pour tester la transition suivante
            forced = true;
        }
        rows.push({ label, role, from, expected, got, ok, forced, is500, err: errs[0] });
    }

    console.log('\n════════════ MARCHE CYCLE DE VIE (rôles réels) ════════════');
    for (const r of rows) {
        const mark = r.ok ? '✅' : '❌';
        const forced = r.forced ? ' ⟳forcé' : '';
        const b500 = r.is500 ? ' ⚠500' : '';
        console.log(
            `${mark} ${String(r.role).padEnd(13)} ${r.label.padEnd(32)} ` +
            `${String(r.from).padEnd(22)}→ attendu=${String(r.expected).padEnd(22)} obtenu=${String(r.got).padEnd(22)}${forced}${b500}`,
        );
        if (r.err) console.log(`      ↳ ${r.err}`);
    }
    const fails = rows.filter((r) => !r.ok);
    console.log('───────────────────────────────────────────────────────────');
    console.log(`Total: ${rows.length} sauts | ✅ ${rows.length - fails.length} | ❌ ${fails.length}`);
    if (fails.length)
        console.log('Ruptures:\n' + fails.map((f) => `  ❌ ${f.label} (${f.from}→${f.expected}) : ${f.err ?? 'statut obtenu ' + f.got}`).join('\n'));
    console.log('Note: DIAGNOSTIC_Pause / REPARATION_Pause couverts par di-pause-resume-ui.spec (4/4).');

    // Nettoyage (DI jetable de diagnostic).
    await db.collection('dis').deleteOne({ _id: ID });
    await db.collection('stats').deleteMany({ _idDi: ID });
    await db.collection('notifications').deleteMany({ diId: ID });
    await db.collection('system_events').deleteMany({ diId: ID });
    await client.close();
    console.log('(DI de test supprimée)\n');
})().catch((e) => { console.error(e); process.exit(1); });
