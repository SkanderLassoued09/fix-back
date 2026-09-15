#!/usr/bin/env node
/**
 * DI VITRINE « PAUSES » — trois DI pour regarder à la main le compteur de pauses
 * de l'onglet « Temps & chrono » du modal Dossier (`di-info-modal`).
 *
 *   SHOW-P1  DI_pause_finished  FINISHED, cycle 0 — 5 pauses en diagnostic (dont une
 *            nuit), 3 en réparation (dont une attente de pièce > 48 h, « long »).
 *   SHOW-P2  DI_pause_live      DIAGNOSTIC_Pause — 3 pauses closes + 1 pause EN COURS.
 *   SHOW-P3  DI_pause_retour    RETOUR 1 terminé — des pauses dans CHAQUE cycle :
 *            flux original (3 diag + 2 rép) et retour 1 (4 diag dont 49 h « long »,
 *            2 rép), motif de retour, une Stat et une ligne logsdis par cycle.
 *
 *   node scripts/seed-showcase-pauses.mjs           # purge → seed
 *   node scripts/seed-showcase-pauses.mjs --clean   # purge seule
 *
 * Préfixe PROPRE `DI_pause_` : `seed-showcase-di.mjs` purge tout `^DI_show_` et
 * `seed-scenarios.mjs` tout `^DI_scn_` / `^DI_scnv_` à chaque exécution.
 *
 * Cohérence exigée par le modal : Σ segments = `diag_time` / `rep_time` (sinon
 * bannière d'écart) ; chaque pause = entrée `*_Pause` → statut suivant dans
 * `statusHistory` (horloge serveur) ; `Stat.status` MIROIR de `Di.status`.
 */
import { createRequire } from 'module';
import { buildDiTriple, purgeSeed, resolveRefs, writeTriple } from '../utils/di-seed.mjs';

const require = createRequire(import.meta.url);
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:4200';

const PREFIX = 'DI_pause_';
const CLEAN = process.argv.slice(2).includes('--clean');

const TUNIS_OFFSET_MS = 60 * 60 * 1000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const D = (d, h = 0, m = 0) => d * DAY + h * HOUR + m * MIN;

/** `YYYY/MM/DD:HH:mm:ss` en heure murale de Tunis — le format réel de `Stat.pauseLogs`. */
function wallClock(date) {
  const d = new Date(date.getTime() + TUNIS_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`
    + `:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Durée « HH:MM:SS » (heures illimitées), format de `diag_time` / `rep_time`. */
function hhmmss(ms) {
  const s = Math.round(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** J0 = il y a `daysAgo` jours, 08:00 Tunis. */
function dayZero(daysAgo) {
  const base = new Date(Date.now() - daysAgo * DAY);
  base.setUTCHours(7, 0, 0, 0);
  return (ms) => new Date(base.getTime() + ms);
}

/**
 * Déroule un parcours `[statut, décalage]` et en déduit ce que le serveur aurait
 * écrit : historique, segments de travail (entrée IN* → statut suivant), pauses
 * (entrée *_Pause → statut suivant ; la dernière reste ouverte si le dossier est
 * en pause) et cumuls. À appeler PAR CYCLE : un segment ou une pause ne
 * traverse jamais un retour.
 */
function unroll(steps, at) {
  const statusHistory = steps.map(([status, ms]) => ({ status, at: at(ms) }));
  const diagSegments = [];
  const repSegments = [];
  const pauseLogs = [];
  steps.forEach(([status, ms], i) => {
    const next = steps[i + 1];
    if (status === 'INDIAGNOSTIC' && next) {
      diagSegments.push({ startedAt: at(ms), stoppedAt: at(next[1]), _id: new ObjectId() });
    }
    if (status === 'INREPARATION' && next) {
      repSegments.push({ startedAt: at(ms), stoppedAt: at(next[1]), _id: new ObjectId() });
    }
    if (status.endsWith('_Pause')) {
      pauseLogs.push({
        pauseType: status === 'DIAGNOSTIC_Pause' ? 'diag' : 'rep',
        pauseStart: wallClock(at(ms)),
        pauseEnd: next ? wallClock(at(next[1])) : null,
        _id: new ObjectId(),
      });
    }
  });
  const sum = (segs) => segs.reduce((a, s) => a + (s.stoppedAt - s.startedAt), 0);
  return { statusHistory, diagSegments, repSegments, pauseLogs, diagMs: sum(diagSegments), repMs: sum(repSegments) };
}

function pauseSummary(steps) {
  const out = [];
  steps.forEach(([status, ms], i) => {
    if (!status.endsWith('_Pause')) return;
    const next = steps[i + 1];
    const label = status === 'DIAGNOSTIC_Pause' ? 'diag' : 'rép';
    out.push(`${label} ${next ? `${Math.round((next[1] - ms) / MIN)} min` : 'EN COURS'}`);
  });
  return out.join(', ') || 'aucune';
}

const assignment = (techId, assignedAt) => ({
  tech: techId,
  assignedAt,
  abandonedAt: null,
  motif: null,
  abandonedBy: null,
  diagTimeStart: '00:00:00',
  diagTime: null,
  _id: new ObjectId(),
});

// ─────────────────────────────────────────────────────────────────────────────
// SHOW-P1 — dossier terminé, pauses variées
// ─────────────────────────────────────────────────────────────────────────────

function buildFinished(refs) {
  const id = `${PREFIX}finished`;
  const idnum = 'SHOW-P1';
  const at = dayZero(5);

  const STEPS = [
    ['CREATED', D(0)],
    ['PENDING1', D(0, 0, 15)],
    ['DIAGNOSTIC', D(0, 0, 40)],
    ['INDIAGNOSTIC', D(0, 0, 50)],
    ['DIAGNOSTIC_Pause', D(0, 1, 50)], //  12 min — café
    ['INDIAGNOSTIC', D(0, 2, 2)],
    ['DIAGNOSTIC_Pause', D(0, 3, 2)], //   65 min — déjeuner
    ['INDIAGNOSTIC', D(0, 4, 7)],
    ['DIAGNOSTIC_Pause', D(0, 5, 37)], //  18 h 38 — fin de journée, reprise le lendemain
    ['INDIAGNOSTIC', D(1, 0, 15)],
    ['DIAGNOSTIC_Pause', D(1, 1, 15)], //  3 min
    ['INDIAGNOSTIC', D(1, 1, 18)],
    ['DIAGNOSTIC_Pause', D(1, 2, 0)], //   25 min — appel client
    ['INDIAGNOSTIC', D(1, 2, 25)],
    ['MagasinEstimation', D(1, 3, 0)],
    ['PENDING2', D(1, 5, 0)],
    ['PRICING_DIAG', D(1, 6, 0)],
    ['WAITING_DEVIS', D(1, 6, 30)],
    ['PENDING3', D(2, 3, 0)],
    ['REPARATION', D(2, 4, 0)],
    ['INREPARATION', D(2, 4, 15)],
    ['REPARATION_Pause', D(2, 5, 45)], //  40 min
    ['INREPARATION', D(2, 6, 25)],
    ['REPARATION_Pause', D(2, 7, 0)], //   50 h — attente d'une pièce (> 48 h : « long »)
    ['INREPARATION', D(4, 9, 0)],
    ['REPARATION_Pause', D(4, 10, 0)], //  8 min
    ['INREPARATION', D(4, 10, 8)],
    ['WAITING_BL', D(4, 10, 40)],
    ['FINISHED', D(4, 11, 0)],
  ];
  const u = unroll(STEPS, at);
  const created = at(0);
  const finished = at(STEPS[STEPS.length - 1][1]);

  const triple = buildDiTriple(
    {
      id,
      idnum,
      title: 'Alimentation à découpage Siemens SITOP 24 V — coupures intermittentes',
      next: 'Alimentation SITOP PSU8200 20 A : coupures aléatoires sous charge, LED « DC OK » qui clignote. Diagnostic + réparation demandés.',
      status: 'FINISHED',
      rep: true,
      pdr: true,
      extra: {
        statusHistory: u.statusHistory,
        statusUpdatedAt: finished,
        createdAt: created,
        dateReception: created,
        updatedAt: finished,
        isOpenedOnce: true,
        remarque_tech_diagnostic: 'Condensateurs de sortie C41/C42 hors tolérance (ESR élevé), relais de sortie oxydé.',
        remarque_tech_repair: 'Condensateurs et relais remplacés ; essai 4 h à 18 A sans coupure.',
      },
    },
    refs,
  );
  Object.assign(triple.stat, {
    diag_time: hhmmss(u.diagMs),
    rep_time: hhmmss(u.repMs),
    diagnostiquefinishedFLAG: true,
    reperationfinishedFLAG: true,
    diagSegments: u.diagSegments,
    repSegments: u.repSegments,
    pauseLogs: u.pauseLogs,
    diagAssignments: [assignment(refs.techId, at(D(0, 0, 40)))],
    createdAt: at(D(0, 0, 40)),
    updatedAt: finished,
  });
  Object.assign(triple.logs[0], { openedAt: created, createdAt: created, updatedAt: finished });
  return {
    triple,
    idnum,
    id,
    cycles: [{ label: 'cycle 0', steps: STEPS, stat: triple.stat }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOW-P2 — en diagnostic, EN PAUSE en ce moment
// ─────────────────────────────────────────────────────────────────────────────

function buildLive(refs) {
  const id = `${PREFIX}live`;
  const idnum = 'SHOW-P2';
  const now = new Date();
  now.setUTCSeconds(0, 0);
  const at = (ms) => new Date(now.getTime() + ms);
  const ago = (h, m = 0) => -(h * HOUR + m * MIN);

  const STEPS = [
    ['CREATED', ago(7)],
    ['PENDING1', ago(6, 50)],
    ['DIAGNOSTIC', ago(6, 30)],
    ['INDIAGNOSTIC', ago(6, 20)],
    ['DIAGNOSTIC_Pause', ago(5, 20)], // 15 min
    ['INDIAGNOSTIC', ago(5, 5)],
    ['DIAGNOSTIC_Pause', ago(4, 5)], //  45 min
    ['INDIAGNOSTIC', ago(3, 20)],
    ['DIAGNOSTIC_Pause', ago(2, 50)], // 5 min
    ['INDIAGNOSTIC', ago(2, 45)],
    ['DIAGNOSTIC_Pause', ago(1, 45)], // EN COURS
  ];
  const u = unroll(STEPS, at);
  const created = at(STEPS[0][1]);
  const pausedAt = at(STEPS[STEPS.length - 1][1]);

  const triple = buildDiTriple(
    {
      id,
      idnum,
      title: 'Écran tactile Weintek MT8102iE — dalle qui ne répond plus',
      next: 'IHM Weintek 10" : l\'écran s\'allume mais la dalle tactile ne réagit plus après un choc thermique.',
      status: 'DIAGNOSTIC_Pause',
      rep: true,
      pdr: false,
      extra: {
        statusHistory: u.statusHistory,
        statusUpdatedAt: pausedAt,
        createdAt: created,
        dateReception: created,
        updatedAt: pausedAt,
        isOpenedOnce: true,
      },
    },
    refs,
  );
  Object.assign(triple.stat, {
    diag_time: hhmmss(u.diagMs),
    rep_time: '',
    diagRunStartedAt: null, // en pause : aucun segment ouvert
    diagnostiquefinishedFLAG: false,
    diagSegments: u.diagSegments,
    repSegments: [],
    pauseLogs: u.pauseLogs,
    diagAssignments: [assignment(refs.techId, at(ago(6, 30)))],
    createdAt: at(ago(6, 30)),
    updatedAt: pausedAt,
  });
  Object.assign(triple.logs[0], { openedAt: created, createdAt: created, updatedAt: pausedAt });
  return {
    triple,
    idnum,
    id,
    cycles: [{ label: 'cycle 0', steps: STEPS, stat: triple.stat }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOW-P3 — retour 1 terminé, des pauses dans chaque cycle
// ─────────────────────────────────────────────────────────────────────────────

const RETOUR_MOTIF = 'Même coupure réapparue après 3 jours d\'utilisation sur la ligne du client';

function buildRetour(refs) {
  const id = `${PREFIX}retour`;
  const idnum = 'SHOW-P3';
  const at = dayZero(9);

  // Flux original : diagnostic sans pièce → devis → réparation → FINISHED.
  const CYCLE0 = [
    ['CREATED', D(0)],
    ['PENDING1', D(0, 0, 20)],
    ['DIAGNOSTIC', D(0, 0, 45)],
    ['INDIAGNOSTIC', D(0, 0, 55)],
    ['DIAGNOSTIC_Pause', D(0, 2, 0)], //   20 min
    ['INDIAGNOSTIC', D(0, 2, 20)],
    ['DIAGNOSTIC_Pause', D(0, 4, 0)], //   55 min — déjeuner
    ['INDIAGNOSTIC', D(0, 4, 55)],
    ['DIAGNOSTIC_Pause', D(0, 6, 0)], //   10 min
    ['INDIAGNOSTIC', D(0, 6, 10)],
    ['PENDING2', D(0, 7, 0)],
    ['PRICING_DIAG', D(0, 7, 30)],
    ['WAITING_DEVIS', D(0, 8, 0)],
    ['PENDING3', D(1, 2, 0)],
    ['REPARATION', D(1, 3, 0)],
    ['INREPARATION', D(1, 3, 15)],
    ['REPARATION_Pause', D(1, 4, 45)], //  30 min
    ['INREPARATION', D(1, 5, 15)],
    ['REPARATION_Pause', D(1, 6, 0)], //   19 h — nuit
    ['INREPARATION', D(2, 1, 0)],
    ['WAITING_BL', D(2, 2, 0)],
    ['WAITING_FACTURE', D(2, 5, 0)],
    ['FINISHED', D(2, 8, 0)],
  ];
  // Retour 1 : erreur Fixtronix sans pièce → réparation directe (raccourci retour).
  const CYCLE1 = [
    ['RETOUR1', D(5, 2, 0)],
    ['PENDING1', D(5, 2, 1)],
    ['DIAGNOSTIC', D(5, 3, 0)],
    ['INDIAGNOSTIC', D(5, 3, 10)],
    ['DIAGNOSTIC_Pause', D(5, 4, 10)], //  15 min
    ['INDIAGNOSTIC', D(5, 4, 25)],
    ['DIAGNOSTIC_Pause', D(5, 5, 0)], //   49 h — attente du client pour l'essai sur site (« long »)
    ['INDIAGNOSTIC', D(7, 6, 0)],
    ['DIAGNOSTIC_Pause', D(7, 7, 0)], //   8 min
    ['INDIAGNOSTIC', D(7, 7, 8)],
    ['DIAGNOSTIC_Pause', D(7, 7, 40)], //  35 min
    ['INDIAGNOSTIC', D(7, 8, 15)],
    ['PENDING3', D(7, 8, 45)],
    ['REPARATION', D(7, 9, 0)],
    ['INREPARATION', D(7, 9, 10)],
    ['REPARATION_Pause', D(7, 10, 10)], // 25 min
    ['INREPARATION', D(7, 10, 35)],
    ['REPARATION_Pause', D(7, 11, 5)], //  12 min
    ['INREPARATION', D(7, 11, 17)],
    ['WAITING_BL', D(7, 11, 47)],
    ['FINISHED', D(8, 2, 0)],
  ];
  const u0 = unroll(CYCLE0, at);
  const u1 = unroll(CYCLE1, at);
  const created = at(0);
  const closed0 = at(CYCLE0[CYCLE0.length - 1][1]);
  const retourAt = at(CYCLE1[0][1]);
  const finished = at(CYCLE1[CYCLE1.length - 1][1]);

  const triple = buildDiTriple(
    {
      id,
      idnum,
      title: 'Variateur Schneider Altivar ATV320 — coupures en charge',
      next: 'Variateur ATV320 4 kW : coupe le moteur en charge (défaut OBF). Diagnostic + réparation demandés.',
      status: 'FINISHED',
      cycle: 1,
      rep: true,
      pdr: false,
      fixtronix: true,
      extra: {
        statusHistory: [...u0.statusHistory, ...u1.statusHistory],
        statusUpdatedAt: finished,
        createdAt: created,
        dateReception: created,
        updatedAt: finished,
        isOpenedOnce: true,
        retourReason: RETOUR_MOTIF,
        retourDate: retourAt,
        remarque_tech_diagnostic: 'Retour : résistance de freinage mal serrée côté bornier (échauffement), défaut de notre intervention.',
        remarque_tech_repair: 'Bornier resserré au couple, résistance de freinage contrôlée ; essai 3 h en charge sans défaut.',
      },
    },
    refs,
  );

  // Stat du RETOUR 1 (celle que la fabrique pose, ignoreCount 1).
  Object.assign(triple.stat, {
    diag_time: hhmmss(u1.diagMs),
    rep_time: hhmmss(u1.repMs),
    diagnostiquefinishedFLAG: true,
    reperationfinishedFLAG: true,
    diagSegments: u1.diagSegments,
    repSegments: u1.repSegments,
    pauseLogs: u1.pauseLogs,
    diagAssignments: [assignment(refs.techId, at(D(5, 3, 0)))],
    createdAt: at(D(5, 3, 0)),
    updatedAt: finished,
  });
  // Stat du FLUX ORIGINAL : une Stat par cycle, index unique {_idDi, ignoreCount}.
  const stat0 = {
    ...triple.stat,
    _id: `stat-${id}-0`,
    status: 'FINISHED',
    ignoreCount: 0,
    retour_count: 0,
    diag_time: hhmmss(u0.diagMs),
    rep_time: hhmmss(u0.repMs),
    diagSegments: u0.diagSegments,
    repSegments: u0.repSegments,
    pauseLogs: u0.pauseLogs,
    diagAssignments: [assignment(refs.techId, at(D(0, 0, 45)))],
    createdAt: at(D(0, 0, 45)),
    updatedAt: closed0,
  };

  // Lignes logsdis : cycle 0 clos à l'ouverture du retour, retour ouvert au RETOUR1.
  Object.assign(triple.logs[0], {
    status: 'FINISHED',
    openedAt: created,
    closedAt: retourAt,
    createdAt: created,
    updatedAt: closed0,
    remarque_tech_diagnostic: 'Résistance de freinage en surchauffe, connecteur de puissance noirci.',
    remarque_tech_repair: 'Connecteur remplacé, résistance de freinage contrôlée.',
  });
  Object.assign(triple.logs[1], {
    openedAt: retourAt,
    createdAt: retourAt,
    updatedAt: finished,
    retourReason: RETOUR_MOTIF,
    retourDate: retourAt,
    remarque_tech_diagnostic: triple.di.remarque_tech_diagnostic,
    remarque_tech_repair: triple.di.remarque_tech_repair,
  });

  // Motif du bandeau « Retour 1 » : lu dans le journal (payload.reason).
  const events = [
    {
      type: 'DI_RETOUR_1',
      diId: id,
      actorId: refs.adminId ?? null,
      actorRole: refs.adminId ? 'ADMIN_MANAGER' : null,
      message: `Retour 1 (${idnum})`,
      payload: { level: 1, reason: RETOUR_MOTIF, status: 'RETOUR1' },
      createdAt: retourAt,
      __v: 0,
    },
  ];

  return {
    triple,
    idnum,
    id,
    extraStats: [stat0],
    events,
    cycles: [
      { label: 'flux original', steps: CYCLE0, stat: stat0 },
      { label: 'retour 1', steps: CYCLE1, stat: triple.stat },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(MONGO_DB);
  try {
    const purged = await purgeSeed(db, PREFIX);
    purged.audits = (await db.collection('audits').deleteMany({ _idDoc: { $regex: `^${PREFIX}` } })).deletedCount;
    if (CLEAN) {
      console.log(`\nNettoyage (base ${MONGO_DB}) — ${JSON.stringify(purged)}\n`);
      return;
    }

    const refs = await resolveRefs(db);
    const seeded = [buildFinished(refs), buildLive(refs), buildRetour(refs)];
    for (const s of seeded) {
      await writeTriple(db, s.triple);
      if (s.extraStats?.length) await db.collection('stats').insertMany(s.extraStats);
      if (s.events?.length) await db.collection('system_events').insertMany(s.events);
    }

    console.log(`\n════════ DI « PAUSES » seedées dans ${MONGO_DB} ════════`);
    console.log(`  Technicien : @${refs.techName}`);
    for (const s of seeded) {
      console.log(`\n  ${s.idnum}  (${s.id}) — ${s.triple.di.status}${s.triple.di.ignoreCount ? ` · ${s.triple.di.ignoreCount} retour` : ''}`);
      for (const c of s.cycles) {
        console.log(`    ${c.label} : diag_time ${c.stat.diag_time || '—'} · rep_time ${c.stat.rep_time || '—'}`);
        console.log(`      pauses : ${pauseSummary(c.steps)}`);
      }
      console.log(`    ${FRONT_URL}/tickets/ticket/ticket-list?di=${s.id}&action=detail  → onglet « Temps & chrono »`);
    }
    console.log(`\nNettoyage : node scripts/seed-showcase-pauses.mjs --clean\n`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error('ERREUR seed pauses :', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
