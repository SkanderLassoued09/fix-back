/**
 * Seed manuel — une DI en WAITING_BL, avec la VRAIE alerte BL « cœur qui bat ».
 *
 * On NE force PAS le statut en base : on insère la DI en INREPARATION (sans BL)
 * puis on appelle la vraie mutation `changestatusToFinishReparation`, qui la fait
 * passer en WAITING_BL et ÉMET la notification persistante `DI_DOC_BL_PENDING`
 * (destinataires : Coordinator, Manager, Admin_Tech, Admin_Manager). C'est la
 * chaîne réelle → ce que le front affiche est exactement ce que produit l'appli.
 *
 * Laissé en place (pas de cleanup) pour l'observer dans l'appli.
 *   node scripts/seed-waiting-bl.js
 */
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const GRAPHQL_URL = process.env.API_URL
    ? `${process.env.API_URL}/graphql`
    : 'http://localhost:3000/graphql';

const ID = 'DI_blseed_manual';
const IDNUM = 'BL-SEED-001';

function adminToken() {
    const p = path.join(__dirname, '..', '.auth', 'ADMIN_MANAGER.json');
    const st = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (st.origins?.[0]?.localStorage || []).find((e) => e.name === 'token')
        ?.value;
}

(async () => {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db(MONGO_DB);
    const now = new Date();

    // Idempotent : on repart propre à chaque exécution.
    await db.collection('dis').deleteOne({ _id: ID });
    await db.collection('stats').deleteMany({ _idDi: ID });
    await db.collection('notifications').deleteMany({ diId: ID });
    await db.collection('system_events').deleteMany({ diId: ID });

    // Un vrai client/entreprise pour un rendu réaliste dans « Affectation des Fichiers ».
    const someClient = await db
        .collection('clients')
        .findOne({ isDeleted: { $ne: true } });

    await db.collection('dis').insertOne({
        _id: ID,
        _idnum: IDNUM,
        title: 'SEED — DI en attente de BL',
        description: 'DI réparée, en attente du bon de livraison (seed manuel).',
        status: 'INREPARATION', // la mutation la fera passer en WAITING_BL
        can_be_repaired: true,
        contain_pdr: true,
        ignoreCount: 0,
        isDeleted: false,
        client_id: someClient?._id ?? null,
        current_roles: ['Tech'],
        current_workers_ids: ['6623d4fea953a0ebca67e7db'],
        // pas de bon_de_livraison → l'alerte battante est émise
        createdAt: now,
        updatedAt: now,
    });
    await db.collection('stats').insertOne({
        _id: `stat-${ID}`,
        _idDi: ID,
        diRef: ID,
        id_tech_diag: '6623d4fea953a0ebca67e7db',
        id_tech_rep: '6623d4fea953a0ebca67e7db',
        status: 'INREPARATION',
        diag_time: '00:10:00',
        rep_time: '00:20:00',
        ignoreCount: 0,
        retour_count: 0,
        pauseLogs: [],
        createdAt: now,
        updatedAt: now,
    });

    // Chaîne réelle : fin de réparation → WAITING_BL + notif DI_DOC_BL_PENDING.
    const token = adminToken();
    const resp = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-test-run': '1',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
            query: `mutation { changestatusToFinishReparation(_id: "${ID}") { _id status } }`,
        }),
    });
    const body = await resp.json().catch(() => ({}));
    if (body.errors) {
        console.error('❌ mutation errors:', JSON.stringify(body.errors, null, 2));
    }

    const di = await db
        .collection('dis')
        .findOne({ _id: ID }, { projection: { status: 1, _idnum: 1 } });
    const notifs = await db
        .collection('notifications')
        .find({ diId: ID })
        .toArray();

    console.log('\n──────── SEED WAITING_BL ────────');
    console.log('DI        :', ID, '/', di?._idnum);
    console.log('status    :', di?.status, di?.status === 'WAITING_BL' ? '✅' : '⚠️ (attendu WAITING_BL)');
    console.log('client_id :', someClient?._id ?? '(aucun)');
    console.log('notifications sur la DI :', notifs.length);
    for (const n of notifs) {
        console.log(
            `  • type=${n.type}  roles=${JSON.stringify(n.roles ?? n.role ?? n.recipients ?? [])}  seen=${n.seen ?? n.isSeen ?? '-'}  msg="${n.message}"`,
        );
    }
    const beat = notifs.filter((n) => n.type === 'DI_DOC_BL_PENDING');
    console.log(
        `\nAlerte battante DI_DOC_BL_PENDING : ${beat.length > 0 ? '✅ présente' : '❌ absente'}`,
    );
    console.log('─────────────────────────────────\n');

    await client.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
