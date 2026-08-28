/**
 * Purge des ANCRES DE CHRONO PÉRIMÉES (`Stat.diagRunStartedAt` / `repRunStartedAt`).
 *
 * Une ancre ouverte signifie « un segment de travail est en cours ». On en a
 * retrouvé 25 restées ouvertes, jusqu'à 1400 h, sur des DI qui ne sont PLUS dans
 * leur phase de travail (FINISHED, PRICING, PENDING2, CONFIRMATION…). Le front
 * calculait `cumulé + (maintenant − ancre)` et affichait des centaines d'heures.
 *
 * Ce script VIDE ces ancres SANS RIEN CUMULER : on ne facture pas un temps qu'on
 * sait faux, et on ne peut pas reconstituer la durée réellement travaillée.
 * `diag_time` / `rep_time` ne sont jamais modifiés.
 *
 * Le code corrigé empêche désormais d'en créer de nouvelles (fermeture du segment
 * à chaque sortie de phase + plafond de plausibilité) ; ce script traite l'existant.
 *
 *   node scripts/clear-stale-timer-anchors.js            # DRY-RUN (n'écrit rien)
 *   node scripts/clear-stale-timer-anchors.js --apply    # applique
 *   MONGO_DB=fixtronixproddb node scripts/clear-stale-timer-anchors.js --apply
 */
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const APPLY = process.argv.includes('--apply');

// Statuts pendant lesquels le chrono a le DROIT de courir (miroir de
// DIAG_RUNNING_STATUS_VALUES / REPAIR_RUNNING_STATUS_VALUES côté front et de
// StatService.DIAG_RUNNING_STATUSES côté back).
const DIAG_RUNNING = ['DIAGNOSTIC', 'INDIAGNOSTIC'];
const REP_RUNNING = ['REPARATION', 'INREPARATION'];
// Filet supplémentaire : même DANS la phase, un segment de plus de 12 h est une
// session abandonnée (onglet fermé sans pause).
const MAX_PLAUSIBLE_LEG_MS = 12 * 60 * 60 * 1000;

const hours = (ms) => Math.round(ms / 3600000);

(async () => {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db(MONGO_DB);
    const now = Date.now();

    const rows = await db
        .collection('stats')
        .find(
            { $or: [{ diagRunStartedAt: { $ne: null } }, { repRunStartedAt: { $ne: null } }] },
            { projection: { _idDi: 1, status: 1, diag_time: 1, rep_time: 1, diagRunStartedAt: 1, repRunStartedAt: 1 } },
        )
        .toArray();

    const targets = [];
    for (const r of rows) {
        const unset = {};
        const why = [];
        if (r.diagRunStartedAt) {
            const age = now - new Date(r.diagRunStartedAt).getTime();
            if (!DIAG_RUNNING.includes(String(r.status))) {
                unset.diagRunStartedAt = ''; why.push(`diag: hors phase (${r.status}, ${hours(age)} h)`);
            } else if (age > MAX_PLAUSIBLE_LEG_MS) {
                unset.diagRunStartedAt = ''; why.push(`diag: abandonné (${hours(age)} h)`);
            }
        }
        if (r.repRunStartedAt) {
            const age = now - new Date(r.repRunStartedAt).getTime();
            if (!REP_RUNNING.includes(String(r.status))) {
                unset.repRunStartedAt = ''; why.push(`rep: hors phase (${r.status}, ${hours(age)} h)`);
            } else if (age > MAX_PLAUSIBLE_LEG_MS) {
                unset.repRunStartedAt = ''; why.push(`rep: abandonné (${hours(age)} h)`);
            }
        }
        if (Object.keys(unset).length) targets.push({ _id: r._id, _idDi: r._idDi, unset, why });
    }

    console.log(`\nBase : ${MONGO_DB}   |   ancres ouvertes : ${rows.length}   |   à purger : ${targets.length}`);
    console.log(APPLY ? '>>> MODE APPLICATION <<<\n' : '>>> DRY-RUN — aucune écriture (relancer avec --apply) <<<\n');
    for (const t of targets) {
        console.log(`  ${String(t._idDi).padEnd(26)} ${t.why.join(' | ')}`);
    }

    if (APPLY) {
        let n = 0;
        for (const t of targets) {
            const res = await db.collection('stats').updateOne({ _id: t._id }, { $unset: t.unset });
            n += res.modifiedCount ?? 0;
        }
        console.log(`\n${n} document(s) purgé(s). diag_time / rep_time INCHANGÉS.`);
    }
    console.log('');
    await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
