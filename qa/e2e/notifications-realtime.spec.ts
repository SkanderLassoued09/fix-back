import { test, expect, request as apiRequest } from '@playwright/test';
import { gqlPost } from '../utils/graphql';

/**
 * Notifications REAL-TIME audit — for EVERY notification-emitting workflow step
 * (initial cycle + retour), prove the CONCERNED role(s) receive the notification
 * BOTH in real-time (socket `notification.new`) AND in base (a `notifications`
 * row for that user). Sound rides on the same socket event (verified separately
 * in the client; if the socket event lands, the two-tone plays).
 *
 * Design: one seeded DI per step, put in the exact precondition status, then the
 * real GraphQL mutation is fired. A socket is connected per role (token signed
 * like the real login: {_id, role, username}, secret 'hide-me'), so we observe
 * exactly who receives what. Doc-upload steps (devis/BC/BL) are excluded — they
 * hit Google Drive; their emit path is identical and covered by unit tests.
 *
 * Runs against the dev backend on :3000 + Mongo `fixtronixproddb`. All seeded
 * docs + emitted test notifications/events are hard-deleted in afterAll.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { io } = require('/home/skander/Desktop/fx/fix-front/node_modules/socket.io-client');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jwt = require('/home/skander/Desktop/fx/fix-back/node_modules/jsonwebtoken');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MongoClient } = require('mongodb');

const MONGO = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const SECRET = 'hide-me';
const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const TAG = Date.now().toString(36);

// role key → stored profile role value (Coordinator = the DB typo COORDIANTOR).
const ROLE_VALUE: Record<string, string> = {
    COORDINATOR: 'COORDIANTOR',
    TECH: 'TECH',
    MAGASIN: 'MAGASIN',
    MANAGER: 'MANAGER',
    ADMIN_MANAGER: 'ADMIN_MANAGER',
    ADMIN_TECH: 'ADMIN_TECH',
};

const roleUsers: Record<string, { _id: string; username: string }> = {};
const sockets: Record<string, { socket: any; received: any[] }> = {};
// Broadcast `updateTicket` (rafraîchit les LISTES de tous les profils en temps
// réel — indépendant des notifications ERP ciblées).
const updateTicketEvents: any[] = [];
const seeded: Array<{ di: string; stat: string }> = [];
let adminToken = '';
let apiCtx: any;

async function withProdDb<T>(fn: (db: any) => Promise<T>): Promise<T> {
    const client = new MongoClient(MONGO);
    await client.connect();
    try {
        return await fn(client.db(DB));
    } finally {
        await client.close();
    }
}

function waitForNotif(
    key: string,
    type: string,
    diId: string,
    ms = 6000,
): Promise<any | null> {
    const started = Date.now();
    return new Promise((resolve) => {
        const tick = () => {
            const hit = sockets[key]?.received.find(
                (n) => n?.type === type && n?.diId === diId,
            );
            if (hit) return resolve(hit);
            if (Date.now() - started > ms) return resolve(null);
            setTimeout(tick, 100);
        };
        tick();
    });
}

function waitForUpdateTicket(diId: string, ms = 6000): Promise<boolean> {
    const started = Date.now();
    const matches = (m: any) => {
        const c = m?.content ?? {};
        const ids = [
            c.result?._id,
            c.states?._id,
            c.di?._id,
            c.result?.di?._id,
            c.states?.di?._id,
        ].map((x) => (x == null ? null : String(x)));
        return ids.includes(diId);
    };
    return new Promise((resolve) => {
        const tick = () => {
            if (updateTicketEvents.some(matches)) return resolve(true);
            if (Date.now() - started > ms) return resolve(false);
            setTimeout(tick, 100);
        };
        tick();
    });
}

test.beforeAll(async () => {
    // 1) Resolve one real user per role from the running app's DB. Roles with
    //    NO user in this DB (e.g. ADMIN_TECH here) are skipped — their recipients
    //    resolve to zero server-side, so there's nobody to verify; the other
    //    concerned roles still receive the notification.
    await withProdDb(async (db) => {
        for (const [key, role] of Object.entries(ROLE_VALUE)) {
            const p = await db
                .collection('profiles')
                .findOne({ role }, { projection: { _id: 1, username: 1 } });
            if (!p) {
                console.warn(`⚠ no ${role} user in ${DB} — role ${key} unverifiable (skipped)`);
                continue;
            }
            roleUsers[key] = { _id: String(p._id), username: p.username };
        }
    });
    if (!roleUsers.ADMIN_MANAGER)
        throw new Error('No ADMIN_MANAGER user — cannot drive mutations.');

    // 2) Admin token to drive the (unauthenticated-or-guarded) mutations.
    adminToken = jwt.sign(
        {
            _id: roleUsers.ADMIN_MANAGER._id,
            role: 'ADMIN_MANAGER',
            username: roleUsers.ADMIN_MANAGER.username,
        },
        SECRET,
        { expiresIn: '1d' },
    );

    // 3) One authenticated socket per role (exactly like the real client).
    for (const [key, u] of Object.entries(roleUsers)) {
        const token = jwt.sign(
            { _id: u._id, role: ROLE_VALUE[key], username: u.username },
            SECRET,
            { expiresIn: '1d' },
        );
        const socket = io(BASE, {
            auth: (cb: any) => cb({ token }),
            transports: ['websocket', 'polling'],
        });
        const received: any[] = [];
        socket.on('notification.new', (n: any) => received.push(n));
        socket.on('updateTicket', (m: any) => updateTicketEvents.push(m));
        await new Promise<void>((res, rej) => {
            socket.on('connect', () => res());
            socket.on('connect_error', (e: any) =>
                rej(new Error(`socket ${key} connect_error: ${e?.message}`)),
            );
            setTimeout(() => rej(new Error(`socket ${key} connect timeout`)), 8000);
        });
        sockets[key] = { socket, received };
    }
    apiCtx = await apiRequest.newContext();
});

test.afterAll(async () => {
    for (const k of Object.keys(sockets)) sockets[k].socket.disconnect();
    await withProdDb(async (db) => {
        const diIds = seeded.map((s) => s.di);
        const statIds = seeded.map((s) => s.stat);
        await db.collection('dis').deleteMany({ _id: { $in: diIds } });
        await db.collection('stats').deleteMany({ _id: { $in: statIds } });
        await db.collection('notifications').deleteMany({ diId: { $in: diIds } });
        await db
            .collection('system_events')
            .deleteMany({ diId: { $in: diIds } });
    });
    if (apiCtx) await apiCtx.dispose();
});

type Step = {
    name: string;
    from: string; // seeded precondition status
    type: string; // expected notification type
    concerned: string[]; // role keys that MUST receive it
    absent?: string[]; // role keys that must NOT receive it (spot check)
    mutation: (di: string) => string;
    pdr?: boolean;
    ignoreCount?: number;
    techDiag?: boolean; // seed Stat.id_tech_diag = TECH
    techRep?: boolean; // seed Stat.id_tech_rep = TECH
    canRepairFalse?: boolean; // seed can_be_repaired = false (for send-back-to-diag)
    expectBroadcast?: boolean; // also assert an updateTicket broadcast (list refresh)
    create?: boolean; // the mutation CREATES the DI (createDi) — no seed, capture _id
};

const M = (op: string) => `mutation { ${op} }`;

const STEPS: Step[] = [
    { name: 'DI créée → à affecter', from: 'CREATED', type: 'DI_PENDING1', concerned: ['COORDINATOR'], absent: ['TECH'], expectBroadcast: true, mutation: (d) => M(`manager_Pending1(_id: "${d}") { _id status }`) },
    // Création DIRECTE en PENDING1 (case cochée) — c'est LE cas signalé : la
    // coordination doit être notifiée ET la liste appendre la DI (updateTicket).
    { name: 'Création DIRECTE en PENDING1 (createDi)', from: 'CREATED', type: 'DI_PENDING1', concerned: ['COORDINATOR'], expectBroadcast: true, create: true, mutation: () => M(`createDi(createDiInput: { title: "QA notif create", status: "PENDING1", can_be_repaired: true }) { _id status _idnum }`) },
    { name: 'Affectation DIAGNOSTIC', from: 'PENDING1', type: 'DI_ASSIGNED_DIAG', concerned: ['TECH'], absent: ['MAGASIN'], techDiag: true, mutation: (d) => M(`coordinatorSendingDiDiag(_idDI: "${d}") { _id status }`) },
    { name: 'Diagnostic terminé → magasin (estimation)', from: 'INDIAGNOSTIC', type: 'DI_MAGASIN_ESTIMATION', concerned: ['MAGASIN'], pdr: true, mutation: (d) => M(`changeStatusMagasinEstimation(_id: "${d}")`) },
    { name: 'Diagnostic → à facturer', from: 'INDIAGNOSTIC', type: 'DI_PENDING2', concerned: ['COORDINATOR'], mutation: (d) => M(`magasinTech_Pending2(_id: "${d}") { _id status }`) },
    { name: 'À tarifer', from: 'PENDING2', type: 'DI_PRICING', concerned: ['ADMIN_MANAGER', 'ADMIN_TECH'], mutation: (d) => M(`changeStatusPricing(_id: "${d}")`) },
    { name: 'Prix fixé → attente devis', from: 'PRICING', type: 'DI_NEGOTIATION1', concerned: ['MANAGER', 'COORDINATOR', 'ADMIN_TECH', 'ADMIN_MANAGER'], mutation: (d) => M(`changeStatusNegociate1(_id: "${d}")`) },
    { name: 'Négociation 2', from: 'NEGOTIATION1', type: 'DI_NEGOTIATION2', concerned: ['ADMIN_MANAGER'], mutation: (d) => M(`changeStatusNegociate2(_id: "${d}")`) },
    { name: 'DI au magasin (préparation)', from: 'INDIAGNOSTIC', type: 'DI_IN_MAGASIN', concerned: ['MAGASIN'], mutation: (d) => M(`changeStatusInMagasin(_id: "${d}")`) },
    { name: 'Magasin terminé → à affecter répa', from: 'WAITING_BC', type: 'DI_PENDING3', concerned: ['COORDINATOR'], mutation: (d) => M(`changeStatusPending3(_id: "${d}")`) },
    { name: 'Affectation RÉPARATION', from: 'PENDING3', type: 'DI_ASSIGNED_REP', concerned: ['TECH'], absent: ['MAGASIN'], techRep: true, mutation: (d) => M(`changeStatusRepaire(_id: "${d}")`) },
    { name: 'Réparation terminée → attente BL', from: 'INREPARATION', type: 'DI_REP_FINISHED', concerned: ['COORDINATOR', 'MANAGER', 'ADMIN_TECH', 'ADMIN_MANAGER'], mutation: (d) => M(`changestatusToFinishReparation(_id: "${d}") { _id status }`) },
    { name: 'Clôture (FINISHED, retour)', from: 'INDIAGNOSTIC', type: 'DI_FINISHED', concerned: ['MANAGER', 'ADMIN_MANAGER', 'ADMIN_TECH', 'COORDINATOR', 'MAGASIN'], absent: ['TECH'], ignoreCount: 1, mutation: (d) => M(`changestatusToFinishReparation(_id: "${d}") { _id status }`) },
    // PENDING1 par d'AUTRES chemins que manager_Pending1 (bugs corrigés : la
    // coordination n'était pas notifiée sur ces passages en PENDING1).
    { name: 'Passage PENDING1 (changeToPending1)', from: 'CREATED', type: 'DI_PENDING1', concerned: ['COORDINATOR'], expectBroadcast: true, mutation: (d) => M(`changeToPending1(_id: "${d}")`) },
    { name: 'Renvoi au diagnostic (PRICING → PENDING1)', from: 'PRICING', type: 'DI_PENDING1', concerned: ['COORDINATOR'], canRepairFalse: true, mutation: (d) => M(`sendDiBackToDiagnostic(_id: "${d}") { _id status }`) },
    // Nouvelle feature ABANDON : le tech abandonne le diagnostic → la DI revient
    // en PENDING1 et on alerte la coordination (réaffecter) + Admin_Manager /
    // Admin_Tech (propriétaires). Le Tech (auteur) et le Magasin ne reçoivent rien.
    { name: 'ABANDON diagnostic par le tech', from: 'INDIAGNOSTIC', type: 'DI_ABANDONED', concerned: ['COORDINATOR', 'ADMIN_MANAGER', 'ADMIN_TECH'], absent: ['TECH', 'MAGASIN'], techDiag: true, expectBroadcast: true, mutation: (d) => M(`abandonDi(AbandonDiInput: { diId: "${d}", motif: "PANNE_NON_IDENTIFIABLE" }) { _id status }`) },
    { name: 'RETOUR 1', from: 'PENDING1', type: 'DI_RETOUR_1', concerned: ['MANAGER', 'COORDINATOR'], mutation: (d) => M(`changeStatusRetour1(_id: "${d}")`) },
    { name: 'RETOUR 2', from: 'RETOUR1', type: 'DI_RETOUR_2', concerned: ['MANAGER', 'COORDINATOR'], mutation: (d) => M(`changeStatusRetour2(_id: "${d}")`) },
    { name: 'RETOUR 3', from: 'RETOUR2', type: 'DI_RETOUR_3', concerned: ['MANAGER', 'COORDINATOR'], mutation: (d) => M(`changeStatusRetour3(_id: "${d}")`) },
];

STEPS.forEach((s, i) => {
    test(`${String(i + 1).padStart(2, '0')} ${s.name} → ${s.type} → [${s.concerned.join(', ')}]`, async () => {
        let di: string;
        const stat = `STAT_ntf_${TAG}_${i}`;

        if (s.create) {
            // createDi génère son PROPRE _id → on crée d'abord, on récupère l'_id.
            const r = await gqlPost(apiCtx, s.mutation(''), adminToken);
            expect(
                r.errors ?? [],
                `create "${s.name}" errored: ${JSON.stringify(r.errors)}`,
            ).toHaveLength(0);
            di = r.data?.createDi?._id;
            expect(di, 'createDi returned an _id').toBeTruthy();
            seeded.push({ di, stat: '' });
        } else {
            di = `DI_ntf_${TAG}_${i}`;
            seeded.push({ di, stat });
            await withProdDb(async (db) => {
                await db.collection('dis').insertOne({
                    _id: di,
                    _idnum: `NTF-${TAG}-${i}`,
                    title: 'QA notif realtime',
                    status: s.from,
                    client_id: null,
                    isDeleted: false,
                    can_be_repaired: !s.canRepairFalse,
                    contain_pdr: !!s.pdr,
                    array_composants: s.pdr
                        ? [{ nameComposant: 'Fusible', quantity: 1 }]
                        : [],
                    ignoreCount: s.ignoreCount ?? 0,
                    current_roles: ['Manager'],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
                await db.collection('stats').insertOne({
                    _id: stat,
                    _idDi: di,
                    diRef: di,
                    id_tech_diag: s.techDiag ? roleUsers.TECH._id : null,
                    id_tech_rep: s.techRep ? roleUsers.TECH._id : null,
                    status: s.from,
                    ignoreCount: s.ignoreCount ?? 0,
                    retour_count: 0,
                    pauseLogs: [],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
            });

            const r = await gqlPost(apiCtx, s.mutation(di), adminToken);
            expect(
                r.errors ?? [],
                `mutation for "${s.name}" errored: ${JSON.stringify(r.errors)}`,
            ).toHaveLength(0);
        }

        // Only assert roles that actually have a user in this DB.
        const concerned = s.concerned.filter((k) => roleUsers[k]);
        const skipped = s.concerned.filter((k) => !roleUsers[k]);
        if (skipped.length) console.warn(`   (no user for ${skipped.join(', ')} — not asserted)`);
        expect(concerned.length, 'at least one concerned role must be verifiable').toBeGreaterThan(0);

        // REAL-TIME: every concerned role's socket must receive it.
        for (const key of concerned) {
            const got = await waitForNotif(key, s.type, di);
            expect(got, `[real-time] ${key} did NOT receive ${s.type}`).toBeTruthy();
        }
        // Spot-check: non-concerned role must NOT receive it.
        for (const key of (s.absent ?? []).filter((k) => roleUsers[k])) {
            const got = await waitForNotif(key, s.type, di, 1200);
            expect(got, `[isolation] ${key} wrongly received ${s.type}`).toBeFalsy();
        }
        // BASE: a notifications row exists for each concerned user.
        await withProdDb(async (db) => {
            const rows = await db
                .collection('notifications')
                .find({ diId: di, type: s.type })
                .toArray();
            for (const key of concerned) {
                const has = rows.some(
                    (row: any) => String(row.userId) === roleUsers[key]._id,
                );
                expect(has, `[base] no notifications row for ${key} (${s.type})`).toBeTruthy();
            }
        });

        // TEMPS RÉEL des LISTES : certaines étapes doivent aussi diffuser un
        // `updateTicket` pour que les autres profils voient le nouveau statut
        // SANS refresh (ex. abandon → PENDING1).
        if (s.expectBroadcast) {
            const broadcast = await waitForUpdateTicket(di);
            expect(
                broadcast,
                `[temps réel] pas de broadcast updateTicket pour ${s.name} → les listes des autres profils ne se rafraîchiraient pas`,
            ).toBeTruthy();
        }
    });
});
