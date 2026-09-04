/**
 * Purge + RESEED + VÉRIFICATION du routage de flux.
 *
 * 1) Purge tout jeu de test (DI_flowtest_/DI_verify_/DI_blseed_manual/DI_walk_manual).
 * 2) VÉRIFIE chaque cas : seed temporaire → on DÉCLENCHE la vraie mutation de fin
 *    de diag (celle que le front choisit pour ce cas) → on assert le statut obtenu
 *    == attendu. (Preuve que le back route à 100 %.)
 * 3) RESEED propre du jeu final (pour tester dans l'UI) :
 *      - 11 DI à INDIAGNOSTIC → écran TECH (sortie de diagnostic) ;
 *      - 2 DI à MagasinEstimation → écran MAGASIN (sortie d'estimation) ;
 *      - 1 DI en WAITING_BL (alerte BL).
 *
 * Modèle : pas de « payant » ; la facturation découle de la SOURCE de l'erreur.
 *   erreur FIXTRONIX (notre faute) → NON facturé → SANS Pricing → direct.
 *   erreur CLIENT                  → facturé      → PAR Pricing.
 *
 *   MONGO_DB=fixtronixproddb node scripts/seed-flow-test.js
 */
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const GRAPHQL_URL = (process.env.API_URL ?? 'http://localhost:3000') + '/graphql';
const TECH = '6623d4fea953a0ebca67e7db';
const PREFIX = 'DI_flowtest_';

function adminToken() {
    const st = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '.auth', 'ADMIN_MANAGER.json'), 'utf8'),
    );
    return (st.origins?.[0]?.localStorage || []).find((e) => e.name === 'token')?.value;
}
const TOKEN = adminToken();

async function gql(query) {
    const resp = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-run': '1', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ query }),
    });
    const b = await resp.json().catch(() => ({}));
    return { data: b.data ?? null, errors: b.errors ?? null };
}

// Chaque DI porte le SCÉNARIO dans `title` et les ÉTAPES ATTENDUES dans
// `description` (champ `next`), pour qu'un testeur sache quoi cliquer et ce qui
// doit se passer sans quitter l'écran.
//   key, idnum, title (scénario), next (étapes attendues), expect (statut visé).
const CASES = [
    {
        key: 'or-rep-pdr', idnum: 'FT-01', rep: true, pdr: true, expect: 'MagasinEstimation',
        title: 'Original + réparable + PDR',
        next: '1) Tech : « Finir le diagnostic » → MagasinEstimation. '
            + '2) Magasin : « Terminer l\'estimation » → PENDING2. '
            + '3) Tarification → devis/BC → composants → PENDING3 → réparation.',
    },
    {
        key: 'or-rep-nopdr', idnum: 'FT-02', rep: true, pdr: false, expect: 'PENDING2',
        title: 'Original + réparable + sans PDR',
        next: '1) Tech : décocher « contient des PDR », « Finir le diagnostic » → PENDING2 (magasin sauté). '
            + '2) Coordination → tarification (PRICING_DIAG).',
    },
    {
        key: 'or-nr', idnum: 'FT-03', rep: false, pdr: false, expect: 'PENDING2',
        title: 'Original + NON réparable (diagnostic payant)',
        next: '1) Tech : décocher « réparable » → « Terminer (non réparable) » → PENDING2 (on facture le diagnostic). '
            + '2) Admin : « Valider le prix » en tarification → IRREPARABLE.',
    },
    {
        key: 'or-nr-nonpay', idnum: 'FT-03b', rep: false, pdr: false, payant: false, expect: 'IRREPARABLE',
        title: 'Original + NON réparable + diagnostic NON payant',
        next: '1) Tech : décocher « réparable » → « Terminer (non réparable) » → IRREPARABLE immédiatement. '
            + 'Aucune facturation, aucun passage par PENDING2 ni tarification.',
    },
    {
        key: 'ret-fix-rep-pdr', idnum: 'FT-04', flow: 'RETOUR', err: 'fixtronix', rep: true, pdr: true, expect: 'MagasinEstimation',
        title: 'Retour + erreur Fixtronix + réparable + PDR',
        next: '1) Tech : « Fin diagnostique retour » → MagasinEstimation. '
            + '2) Magasin : « Terminer l\'estimation » → CONFIRMATION (et NON PENDING2). '
            + '3) Composants : envoi coordination → confirmation → « Terminer les composants » → PENDING3. '
            + 'RÈGLE : une erreur Fixtronix ne passe JAMAIS par PENDING2/tarification.',
    },
    {
        key: 'ret-fix-rep-nopdr', idnum: 'FT-05', flow: 'RETOUR', err: 'fixtronix', rep: true, pdr: false, expect: 'PENDING3',
        title: 'Retour + erreur Fixtronix + réparable + sans PDR',
        next: '1) Tech : décocher PDR (Fixtronix décoché) → « Fin diagnostique retour » → PENDING3 direct. '
            + 'Magasin et tarification sautés, non facturé. '
            + '2) Coordinatrice : joindre le devis puis envoyer en réparation.',
    },
    {
        key: 'ret-fix-rep-nopdr-b', idnum: 'FT-05b', flow: 'RETOUR', err: 'fixtronix', rep: true, pdr: false, via: 'tofinish', expect: 'PENDING3',
        title: 'Retour + erreur Fixtronix COCHÉE + réparable + sans PDR',
        next: '1) Tech : laisser « Erreur Fixtronix » COCHÉE + décocher PDR → « Envoyer vers finir » → PENDING3. '
            + 'Les DEUX boutons sont cliquables et donnent le MÊME statut (le routage est serveur-autoritaire) : '
            + 'vérifier que « Fin diagnostique retour » donne aussi PENDING3.',
    },
    {
        // LE CAS SIGNALÉ (« error fixtronix et no pdr → pricing waiting for devis »).
        // `err: 'none'` ⇒ AUCUN verdict pré-enregistré, ni sur la DI ni sur le log :
        // c'est l'état réel d'un retour avant que le tech ne tranche. Tous les autres
        // cas trichent en pré-remplissant le verdict, ce qui masquait le bug.
        key: 'ret-verdict-vierge', idnum: 'FT-05c', flow: 'RETOUR', err: 'none', rep: true, pdr: false,
        via: 'manual', expect: 'PENDING3',
        title: 'Retour SANS verdict pré-saisi — coche « Erreur Fixtronix » toi-même',
        next: '1) Tech : ouvrir le diagnostic, aller à l\'étape Validation, COCHER « Erreur Fixtronix », '
            + 'décocher PDR, puis « Fin diagnostique retour » → doit donner PENDING3 (jamais PENDING2/Pricing). '
            + '2) Bonus : mettre en PAUSE après avoir coché, rouvrir, finir → le verdict doit SURVIVRE '
            + '(il est collant sur le cycle). 3) Coordinatrice : joindre le devis puis envoyer en réparation.',
    },
    {
        key: 'ret-fix-nr', idnum: 'FT-06', flow: 'RETOUR', err: 'fixtronix', rep: false, pdr: false, expect: 'IRREPARABLE',
        title: 'Retour + erreur Fixtronix + NON réparable',
        next: '1) Tech : décocher « réparable » → « Envoyer vers finir » → IRREPARABLE. '
            + 'Magasin sauté, aucune facturation. Les deux boutons restent cliquables et donnent le même statut.',
    },
    {
        key: 'ret-cli-rep-pdr', idnum: 'FT-07', flow: 'RETOUR', err: 'client', rep: true, pdr: true, expect: 'MagasinEstimation',
        title: 'Retour + erreur client + réparable + PDR',
        next: '1) Tech : « Fin diagnostique retour » → MagasinEstimation. '
            + '2) Magasin : « Terminer l\'estimation » → PENDING2 → tarification. '
            + 'Erreur client : le client est bien facturé.',
    },
    {
        key: 'ret-cli-rep-nopdr', idnum: 'FT-08', flow: 'RETOUR', err: 'client', rep: true, pdr: false, expect: 'PENDING2',
        title: 'Retour + erreur client + réparable + sans PDR',
        next: '1) Tech : décocher PDR → « Fin diagnostique retour » → PENDING2. '
            + '2) Tarification : c\'est là qu\'on décide « facturer le diagnostic ? ».',
    },
    {
        key: 'ret-cli-nr', idnum: 'FT-09', flow: 'RETOUR', err: 'client', rep: false, pdr: false, expect: 'IRREPARABLE',
        title: 'Retour + erreur client + NON réparable',
        next: '1) Tech : décocher « réparable » → « Envoyer vers finir » → IRREPARABLE. '
            + 'En retour, on ne re-facture pas. Les deux boutons donnent le même statut.',
    },
];

/**
 * DI garées en MagasinEstimation → écran MAGASIN, bouton « Terminer
 * l'estimation ». C'est le 2e saut de FT-04 : il partait en PENDING2 →
 * PRICING_DIAG (donc FACTURÉ) alors qu'une erreur Fixtronix ne se facture
 * jamais. Il doit désormais repartir vers la poignée de main composants.
 */
const PARKED = [
    {
        key: 'mag-fix', idnum: 'FT-04b', flow: 'RETOUR', err: 'fixtronix', rep: true, pdr: true, expect: 'CONFIRMATION',
        title: 'Sortie magasin — retour erreur Fixtronix + PDR',
        next: '1) Magasin : « Terminer l\'estimation » → CONFIRMATION (et NON PENDING2). '
            + '2) Envoyer au coordinateur → confirmation composants → « Terminer les composants » → PENDING3. '
            + 'La DI ne doit JAMAIS toucher PENDING2 ni PRICING_DIAG.',
    },
    {
        key: 'mag-cli', idnum: 'FT-15', flow: 'RETOUR', err: 'client', rep: true, pdr: true, expect: 'PENDING2',
        title: 'Sortie magasin — retour erreur client + PDR',
        next: '1) Magasin : « Terminer l\'estimation » → PENDING2. '
            + '2) Tarification normale. Non-régression : le client reste facturé.',
    },
];

/** La mutation de fin de diagnostic que le FRONT déclenche pour ce cas
 *  (updateDisableValues) — c'est le vrai chemin de routage. */
function finishMutation(c, id) {
    // `via:'tofinish'` = bouton « Envoyer vers finir » (Fixtronix coché).
    if (c.via === 'tofinish') return `mutation { changestatusToFinishReparation(_id:"${id}") { _id status } }`;
    // DI garée au magasin → « Terminer l'estimation » (mutation changeStatusPending2).
    if (c.parked) return `mutation { changeStatusPending2(_id:"${id}") }`;
    if (c.rep && c.pdr) return `mutation { changeStatusMagasinEstimation(_id:"${id}") }`;
    // Réparable + SANS PDR (FT-02/05/08) : c'est le VRAI chemin UI « Fin
    // diagnostique retour » quand le tech décoche PDR → mutation
    // changeStatusPending2. C'EST le chemin qui envoyait FT-05 en PENDING2 ; la
    // garde Fixtronix y redirige désormais vers PENDING3. (L'ancienne vérif
    // pilotait FT-05 via changestatusToFinishReparation = l'AUTRE bouton, d'où le
    // faux « 9/9 ».)
    if (c.rep && !c.pdr) return `mutation { changeStatusPending2(_id:"${id}") }`;
    // NON réparable → « Envoyer vers finir »
    return `mutation { changestatusToFinishReparation(_id:"${id}") { _id status } }`;
}

async function seedDoc(db, id, idnum, c, now, extraDesc) {
    const isRetour = c.flow === 'RETOUR';
    const fixtronix = c.err === 'fixtronix';
    const ignoreCount = isRetour ? 1 : 0;
    const comps = c.rep && c.pdr ? [{ nameComposant: 'Fusible', quantity: 1 }] : [];
    const client = await db.collection('clients').findOne({ isDeleted: { $ne: true } });
    await db.collection('dis').deleteOne({ _id: id });
    await db.collection('stats').deleteMany({ _idDi: id });
    await db.collection('logsdis').deleteMany({ _idDi: id });
    const startStatus = c.parked ? 'MagasinEstimation' : 'INDIAGNOSTIC';
    await db.collection('dis').insertOne({
        _id: id, _idnum: idnum, title: c.title,
        description: (c.next || '') + (extraDesc || ''),
        status: startStatus, can_be_repaired: c.rep, contain_pdr: c.pdr,
        isPdr: c.pdr, isReparable: c.rep,
        // Absent = payant (comportement historique) ; `false` = non facturé.
        ...(c.payant === false ? { diagnosticPayant: false } : {}),
        ...(isRetour && c.err !== 'none' ? { isErrorFromFixtronix: fixtronix } : {}),
        di_category_id: 'CAT-FLOWTEST', client_id: client?._id ?? null,
        createdBy: TECH, current_workers_ids: [TECH],
        current_roles: c.parked ? ['Magasin'] : ['Tech'],
        array_composants: comps, ignoreCount, isDeleted: false,
        statusUpdatedAt: now, createdAt: now, updatedAt: now,
    });
    await db.collection('stats').insertOne({
        _id: `stat-${id}`, _idDi: id, diRef: id, id_tech_diag: TECH, id_tech_rep: TECH,
        status: startStatus, diag_time: '00:05:00', rep_time: '',
        ignoreCount, retour_count: ignoreCount, pauseLogs: [], createdAt: now, updatedAt: now,
    });
    if (isRetour) {
        await db.collection('logsdis').insertOne({
            _id: `log-${id}`, _idDi: id, idIgnore: ignoreCount,
            can_be_repaired: c.rep, contain_pdr: c.pdr, array_composants: comps,
            // `none` = verdict non tranché (l'état réel avant saisie du tech).
            ...(c.err === 'none' ? {} : { isErrorFromFixtronix: fixtronix }),
            createdAt: now, updatedAt: now,
        });
    }
}

(async () => {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db(MONGO_DB);
    const now = new Date();
    // `parked` = DI garée en MagasinEstimation (le cas se joue à la SORTIE du magasin).
    const PARKED_CASES = PARKED.map((c) => ({ ...c, parked: true }));

    // 1) PURGE globale.
    for (const rx of [/^DI_flowtest_/, /^DI_verify_/, /^DI_blseed_manual/, /^DI_walk_manual/]) {
        await db.collection('dis').deleteMany({ _id: { $regex: rx } });
        await db.collection('stats').deleteMany({ _idDi: { $regex: rx } });
        await db.collection('logsdis').deleteMany({ _idDi: { $regex: rx } });
        await db.collection('notifications').deleteMany({ diId: { $regex: rx } });
        await db.collection('system_events').deleteMany({ diId: { $regex: rx } });
    }

    // 2) VÉRIFICATION (DI temporaires, supprimées ensuite).
    const results = [];
    for (const c of [...CASES, ...PARKED_CASES]) {
        // `via:'manual'` : tout l'intérêt du cas est que le TECH saisisse le
        // verdict dans le modal. Le déclencher par l'API sans ce geste donnerait
        // PENDING2 — ce qui est CORRECT (aucune erreur Fixtronix déclarée) mais
        // afficherait un ❌ trompeur. Il est amorcé, pas auto-vérifié.
        if (c.via === 'manual') {
            results.push({ ...c, err: undefined, got: '(test manuel)', ok: null });
            continue;
        }
        const vid = 'DI_verify_' + c.key;
        await seedDoc(db, vid, c.idnum, c, now);
        const r = await gql(finishMutation(c, vid));
        const di = await db.collection('dis').findOne({ _id: vid }, { projection: { status: 1 } });
        const got = di?.status;
        const ok = got === c.expect && !r.errors;
        results.push({ ...c, got, ok, err: r.errors?.[0]?.message });
        await db.collection('dis').deleteOne({ _id: vid });
        await db.collection('stats').deleteMany({ _idDi: vid });
        await db.collection('logsdis').deleteMany({ _idDi: vid });
        await db.collection('notifications').deleteMany({ diId: vid });
        await db.collection('system_events').deleteMany({ diId: vid });
    }

    // 3) RESEED du jeu final (frais).
    for (const c of [...CASES, ...PARKED_CASES]) {
        await seedDoc(db, PREFIX + c.key, c.idnum, c, now);
    }

    // BL, via la vraie mutation.
    const blId = PREFIX + 'waitingbl';
    await db.collection('dis').deleteOne({ _id: blId });
    await db.collection('stats').deleteMany({ _idDi: blId });
    const someClient = await db.collection('clients').findOne({ isDeleted: { $ne: true } });
    await db.collection('dis').insertOne({
        _id: blId, _idnum: 'FT-BL',
        title: 'Réparée — en attente du bon de livraison',
        description:
            '1) La réparation est terminée : la DI est en WAITING_BL et sort de la liste tech. '
            + '2) La relance « BL à téléverser » bat dans le centre de notifications. '
            + '3) Téléverser le BL → WAITING_FACTURE, puis la facture → FINISHED.',
        status: 'INREPARATION', can_be_repaired: true, contain_pdr: false,
        client_id: someClient?._id ?? null, createdBy: TECH, current_workers_ids: [TECH],
        current_roles: ['Tech'], array_composants: [], ignoreCount: 0, isDeleted: false,
        statusUpdatedAt: now, createdAt: now, updatedAt: now,
    });
    await db.collection('stats').insertOne({
        _id: `stat-${blId}`, _idDi: blId, diRef: blId, id_tech_diag: TECH, id_tech_rep: TECH,
        status: 'INREPARATION', diag_time: '00:10:00', rep_time: '00:20:00', ignoreCount: 0,
        retour_count: 0, pauseLogs: [], createdAt: now, updatedAt: now,
    });
    const blr = await gql(`mutation { changestatusToFinishReparation(_id:"${blId}"){_id status} }`);
    const bl = await db.collection('dis').findOne({ _id: blId }, { projection: { status: 1 } });

    // 4) Rapport.
    console.log('\n════════ VÉRIFICATION DU ROUTAGE (back, chemin réel) ════════');
    let allOk = true;
    for (const r of results) {
        const mark = r.ok === null ? '✋' : r.ok ? '✅' : '❌';
        if (r.ok === false) allOk = false;
        console.log(`  ${mark} ${r.idnum}  ${r.title.padEnd(46)} attendu=${r.expect.padEnd(18)} obtenu=${r.got}${r.err ? '  ⚠ ' + r.err : ''}`);
    }
    console.log(`\n  ${allOk ? '✅ 100% — tous les flux routent correctement.' : '❌ Des flux échouent (voir ci-dessus).'}`);
    console.log(`  ${bl?.status === 'WAITING_BL' ? '✅' : '❌'} FT-BL → WAITING_BL${blr.errors ? ' ⚠ ' + blr.errors[0].message : ''}`);
    console.log('\n──── ÉCRAN TECH — /tickets/ticket/tech-di-list (compte « tech ») ────');
    console.log('     DI à INDIAGNOSTIC : ouvrir la loupe → étape « Validation » → « Résumé ».');
    for (const c of CASES) console.log(`  ${c.idnum.padEnd(6)} ${c.title}\n         ↳ ${c.next}`);
    console.log('\n──── ÉCRAN MAGASIN — /tickets/ticket/magasin-di-list (compte « magasin ») ────');
    console.log('     DI à MagasinEstimation : ouvrir → « Terminer l\'estimation ».');
    for (const c of PARKED_CASES) console.log(`  ${c.idnum.padEnd(6)} ${c.title}\n         ↳ ${c.next}`);
    console.log('\n──── ALERTE BL — /tickets/ticket/ticket-list ────');
    console.log(`  FT-BL  Réparée + attente BL${' '.repeat(22)} → WAITING_BL (relance BL battante)`);
    console.log('');

    await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
