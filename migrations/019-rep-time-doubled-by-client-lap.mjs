/**
 * Migration 019 — corriger les `rep_time` comptés DEUX FOIS.
 *
 * POURQUOI. Jusqu'au 2026-09-30, à la pause d'une réparation, le client écrivait
 * `rep_time` = valeur AFFICHÉE (qui contient déjà le segment en cours) via
 * `lapTimeForReaparation`, pendant que le serveur faisait `rep_time += segment`
 * dans `closeRepLeg`. Selon l'ordre d'arrivée, le segment était compté deux fois.
 * Constat en base locale : des Stats à EXACTEMENT 2 × la somme de leurs
 * `repSegments` (ex. 01:31:48 pour 2 755 s de segments). Le temps de réparation
 * sert à la facturation. Le code est corrigé (`closeRepLeg` seul écrit).
 *
 * CE QUE ÇA FAIT : pour chaque Stat ayant des `repSegments`, compare `rep_time`
 * à la somme S des segments.
 *   - `rep_time` ≈ 2 × S (tolérance 2 s par segment) → proposé : `rep_time = S` ;
 *   - autre écart → LISTÉ « à examiner », JAMAIS modifié (temps saisi avant
 *     l'existence des segments, doublement partiel… : pas de règle sûre).
 * `updatedAt` n'est pas modifié.
 *
 * SÉCURITÉ : DRY-RUN par défaut (rapport seul). `--apply` pour écrire, et
 * seulement sur accord explicite. Idempotent : après correction, rep_time ≈ S.
 *
 * Run (depuis fix-back/) :
 *   node migrations/019-rep-time-doubled-by-client-lap.mjs
 *   node migrations/019-rep-time-doubled-by-client-lap.mjs --apply
 * Env : MONGO_URL (défaut mongodb://127.0.0.1:27017), MONGO_DB (défaut
 * fixtronixproddb). NB : chaque poste a SA base — lancer sur chacune.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { MongoClient } = require('mongodb');

const APPLY = process.argv.slice(2).includes('--apply');
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';

if (MONGO_DB === 'fixtronix') {
  console.error("Refus : la base « fixtronix » est morte — la base applicative est « fixtronixproddb ».");
  process.exit(1);
}

const TOLERANCE_PER_SEGMENT_MS = 2000;

function hhmmssToMs(s) {
  const v = (s ?? '').trim();
  if (!/^\d{2,}:\d{2}:\d{2}$/.test(v)) return null;
  const [h, m, sec] = v.split(':').map(Number);
  return (h * 3600 + m * 60 + sec) * 1000;
}

function msToHhmmss(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

const client = new MongoClient(MONGO_URL);
try {
  await client.connect();
  const stats = client.db(MONGO_DB).collection('stats');
  const cursor = stats.find(
    { 'repSegments.0': { $exists: true } },
    { projection: { _idDi: 1, ignoreCount: 1, rep_time: 1, repSegments: 1 } },
  );

  const doubled = [];
  const toReview = [];
  let scanned = 0;
  for await (const s of cursor) {
    scanned++;
    const recorded = hhmmssToMs(s.rep_time);
    if (recorded === null) continue;
    const segs = s.repSegments ?? [];
    const sum = segs.reduce(
      (acc, g) => acc + Math.max(0, new Date(g.stoppedAt) - new Date(g.startedAt)),
      0,
    );
    const tol = TOLERANCE_PER_SEGMENT_MS * Math.max(1, segs.length);
    if (Math.abs(recorded - sum) <= tol) continue; // cohérent
    const row = {
      stat: s._id,
      di: s._idDi,
      cycle: s.ignoreCount ?? 0,
      rep_time: s.rep_time,
      segments: msToHhmmss(sum),
      nbSegments: segs.length,
    };
    if (sum > 0 && Math.abs(recorded - 2 * sum) <= tol) {
      doubled.push({ ...row, corrige: msToHhmmss(sum) });
    } else {
      toReview.push(row);
    }
  }

  console.log(`Base ${MONGO_DB} — ${scanned} Stats avec segments de réparation.`);
  console.log(`\n${doubled.length} rep_time DOUBLÉS (corrigibles) :`);
  console.table(doubled);
  console.log(`\n${toReview.length} autre(s) écart(s) — À EXAMINER, jamais modifiés :`);
  console.table(toReview);

  if (!APPLY) {
    console.log('\nDRY-RUN : rien écrit. Relancer avec --apply pour corriger les doublés.');
  } else {
    let modified = 0;
    for (const d of doubled) {
      const res = await stats.updateOne(
        { _id: d.stat, rep_time: d.rep_time }, // re-filtre : pas d'écrasement concurrent
        { $set: { rep_time: d.corrige } },
        { timestamps: false },
      );
      modified += res.modifiedCount;
    }
    console.log(`\nAPPLIQUÉ : ${modified}/${doubled.length} rep_time corrigés.`);
  }
} finally {
  await client.close();
}
