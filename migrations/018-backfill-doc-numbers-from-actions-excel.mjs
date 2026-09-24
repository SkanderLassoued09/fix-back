/**
 * Migration 018 — reprendre les N° de Devis / BC / BL / Facture de l'ancien
 * Excel « ACTIONS EN COURS » dans l'ERP (`docNumeros`).
 *
 * POURQUOI. L'ERP ne stockait que les PDF (Drive), jamais leur numéro métier
 * (« 130/26 »). Le fichier ACTIONS EN COURS désormais GÉNÉRÉ par l'ERP a besoin
 * de ces numéros ; les nouveaux dépôts les saisissent (champ obligatoire), les
 * DI déjà dans l'ERP les récupèrent ici depuis l'Excel tenu à la main.
 *
 * CE QUE ÇA FAIT (onglet « ACTIONS 2025 », en-tête ligne 2) :
 *   - A N° DI · G Devis · H BC · I BL · K Facture.
 *   - Rapprochement PAR N° DI (`dis._idnum`, « T01 » normalisé en « T1 »). Les
 *     lignes sans DI dans l'ERP (T1–T846, historique papier) sont RAPPORTÉES,
 *     jamais importées.
 *   - Valeurs ignorées : vide, « _ », « Sans », « IRREPARABLE », « ANNULER ».
 *     Tout le reste est repris tel quel (« EMAIL », « TEL », un nom… disent
 *     COMMENT le BC est arrivé : c'est l'information du fichier, on la garde).
 *   - Une valeur « A - B » dont le nombre de parties = nombre de cycles de la DI
 *     est répartie cycle par cycle ; sinon elle va ENTIÈRE sur le cycle courant.
 *   - Écrit `logsdis.docNumeros.<type>` (ligne du cycle) + `dis.docNumeros.<type>`
 *     (miroir, cycle courant seulement).
 *   - E « Date de réception » → `dis.dateReception` quand elle est VIDE (les DI
 *     créées dans l'ERP n'en ont pas : l'export retombait sur `createdAt`, la
 *     date de SAISIE, parfois des semaines après la réception réelle). Stockée à
 *     midi UTC du jour → même jour civil à Tunis quel que soit le fuseau.
 *     SEULE correction d'une valeur existante : l'artefact de l'ancien import
 *     (dates stockées à 22:59:25Z = 23:59:25 à Tunis, soit la VEILLE du jour
 *     Excel, arrondi SheetJS). Reconnu strictement (≤ 2 min avant minuit Tunis
 *     ET veille exacte du jour Excel), rapporté en section CORRIGÉ.
 *   - NE REMPLIT QUE LES CHAMPS VIDES. Un numéro déjà saisi dans l'ERP n'est
 *     jamais écrasé : s'il diffère, c'est un CONFLIT rapporté.
 *   - `docNumeros` est À PART de `driveDocs` : un numéro sans PDF ne fait jamais
 *     passer un document pour présent (portes documentaires inchangées).
 *
 * SÉCURITÉ : DRY-RUN par défaut (rapport seul). `--apply` pour écrire.
 * Idempotent : un 2ᵉ passage n'écrit rien.
 *
 * Run (depuis fix-back/) :
 *   node migrations/018-backfill-doc-numbers-from-actions-excel.mjs "<ACTIONS EN COURS.xlsx>" [--report=<fichier.csv>] [--apply]
 * Env : MONGO_URL (défaut mongodb://127.0.0.1:27017), MONGO_DB (défaut
 * fixtronixproddb). NB : chaque poste a SA base — lancer sur chacune.
 */
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const XLSX_PATH = args.find((a) => !a.startsWith('--'));
const REPORT =
  args.find((a) => a.startsWith('--report='))?.slice('--report='.length) ??
  '018-doc-numbers-report.csv';
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env.MONGO_DB ?? 'fixtronixproddb';
const SHEET = 'ACTIONS 2025';

const COLUMNS = { Devis: 6, BC: 7, BL: 8, Facture: 10 };
const COL_RECEPTION = 4;
const PLACEHOLDERS = new Set(['', '_', 'SANS', 'IRREPARABLE', 'ANNULER']);

if (!XLSX_PATH) {
  console.error(
    'Usage : node migrations/018-backfill-doc-numbers-from-actions-excel.mjs "<fichier.xlsx>" [--report=<csv>] [--apply]',
  );
  process.exit(1);
}
// La base `fixtronix` existe encore sur le même mongod mais est MORTE.
if (MONGO_DB === 'fixtronix') {
  console.error("Refus : la base « fixtronix » est morte — la base applicative est « fixtronixproddb ».");
  process.exit(1);
}

const normRef = (v) => {
  const m = /^T0*(\d+)$/i.exec(String(v ?? '').trim());
  return m ? `T${m[1]}` : null;
};
const cleanValue = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return PLACEHOLDERS.has(s.toUpperCase()) ? null : s;
};
// Série Excel (jours depuis 1899-12-30) → midi UTC du jour. Les rares cellules
// texte (« 12/03/2025 ») sont lues en jj/mm/aaaa ; le reste est ignoré.
const excelDay = (v) => {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    d.setUTCHours(12);
    return d;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v ?? '').trim());
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12)) : null;
};
// Jour civil À TUNIS (aaaa-mm-jj) : les dates déjà en base valent minuit Tunis,
// soit 23 h UTC la VEILLE — les comparer en UTC inventerait des conflits.
const day = (d) =>
  d ? new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Africa/Tunis' }) : '';
// Artefact d'import : l'instant tombe dans les 2 min avant minuit à Tunis ET
// son jour est la veille exacte du jour Excel.
const isImportArtefact = (stored, excelD) => {
  const t = new Date(stored);
  const hm = t.toLocaleTimeString('en-GB', { timeZone: 'Africa/Tunis', hour12: false });
  const nearMidnight = hm >= '23:58:00';
  const next = new Date(new Date(`${day(t)}T12:00:00Z`).getTime() + 86400000);
  return nearMidnight && day(next) === day(excelD);
};
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

// ── Lecture de l'Excel ──────────────────────────────────────────────────────
const wb = XLSX.readFile(XLSX_PATH);
const ws = wb.Sheets[SHEET];
if (!ws) {
  console.error(`Onglet « ${SHEET} » introuvable (onglets : ${wb.SheetNames.join(', ')})`);
  process.exit(1);
}
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }).slice(2);
const excel = new Map(); // ref → { Devis, BC, BL, Facture }
const duplicates = [];
for (const r of rows) {
  const ref = normRef(r[0]);
  if (!ref) continue;
  if (excel.has(ref)) duplicates.push(ref);
  const vals = {};
  for (const [type, col] of Object.entries(COLUMNS)) vals[type] = cleanValue(r[col]);
  excel.set(ref, { vals, reception: excelDay(r[COL_RECEPTION]) });
}

// ── Rapprochement ───────────────────────────────────────────────────────────
const client = new MongoClient(MONGO_URL);
await client.connect();
const db = client.db(MONGO_DB);
const dis = await db
  .collection('dis')
  .find({ _idnum: { $in: [...excel.keys()] } })
  .project({ _idnum: 1, ignoreCount: 1, docNumeros: 1, dateReception: 1 })
  .toArray();
const diByRef = new Map(dis.map((d) => [d._idnum, d]));
const logs = await db
  .collection('logsdis')
  .find({ _idDi: { $in: dis.map((d) => d._id) } })
  .project({ _idDi: 1, idIgnore: 1, docNumeros: 1 })
  .toArray();
const logKey = (id, c) => `${id}#${c}`;
const logByKey = new Map(logs.map((l) => [logKey(l._idDi, l.idIgnore), l]));

const filled = []; // [ref, type, cycle, value, target]
const conflicts = []; // [ref, type, cycle, excel, erp]
const notInErp = [];
const diOps = [];
const logOps = [];

for (const [ref, { vals, reception }] of excel) {
  const di = diByRef.get(ref);
  if (!di) {
    notInErp.push(ref);
    continue;
  }
  const current = di.ignoreCount ?? 0;
  const diSet = {};
  if (reception) {
    if (!di.dateReception) {
      diSet.dateReception = reception;
      filled.push([ref, 'dateReception', '', day(reception), 'dis']);
    } else if (isImportArtefact(di.dateReception, reception)) {
      diSet.dateReception = reception;
      filled.push([ref, 'dateReception', '', `${day(di.dateReception)} → ${day(reception)}`, 'dis (CORRIGÉ)']);
    } else if (day(di.dateReception) !== day(reception)) {
      conflicts.push([ref, 'dateReception', '', day(reception), day(di.dateReception)]);
    }
  }
  for (const [type, value] of Object.entries(vals)) {
    if (!value) continue;
    const parts = value.split(/\s+-\s+/);
    const perCycle =
      current > 0 && parts.length === current + 1
        ? parts.map((p, i) => [i, p])
        : [[current, value]];

    for (const [cycle, part] of perCycle) {
      const log = logByKey.get(logKey(di._id, cycle));
      if (log) {
        const erp = log.docNumeros?.[type];
        if (!erp) {
          logOps.push({
            updateOne: {
              filter: { _id: log._id },
              update: { $set: { [`docNumeros.${type}`]: part } },
            },
          });
          filled.push([ref, type, cycle, part, 'logsdis']);
        } else if (erp !== part) {
          conflicts.push([ref, type, cycle, part, erp]);
        }
      }
      if (cycle === current) {
        const erp = di.docNumeros?.[type];
        if (!erp) {
          diSet[`docNumeros.${type}`] = part;
          filled.push([ref, type, cycle, part, 'dis']);
        } else if (erp !== part) {
          conflicts.push([ref, type, cycle, part, erp]);
        }
      }
    }
  }
  if (Object.keys(diSet).length) {
    diOps.push({ updateOne: { filter: { _id: di._id }, update: { $set: diSet } } });
  }
}

// ── Rapport ─────────────────────────────────────────────────────────────────
const lines = ['section,n_di,document,cycle,valeur_excel,valeur_erp_ou_cible'];
for (const [ref, type, cycle, value, target] of filled) {
  const section = target.includes('CORRIGÉ') ? 'CORRIGÉ' : 'REMPLI';
  lines.push([section, ref, type, cycle, value, target].map(csv).join(','));
}
for (const [ref, type, cycle, ex, erp] of conflicts) {
  lines.push(['CONFLIT', ref, type, cycle, ex, erp].map(csv).join(','));
}
for (const ref of notInErp) lines.push(['HORS_ERP', ref, '', '', '', ''].map(csv).join(','));
for (const ref of duplicates) lines.push(['DOUBLON_EXCEL', ref, '', '', '', ''].map(csv).join(','));
fs.writeFileSync(REPORT, '﻿' + lines.join('\n') + '\n');

console.log(`Excel : ${excel.size} N° DI lus (${duplicates.length} doublon(s), dernière ligne gardée)`);
console.log(`ERP   : ${dis.length} DI rapprochées · ${notInErp.length} ligne(s) Excel hors ERP (rapportées)`);
console.log(
  `À écrire : ${filled.filter((f) => f[1] === 'dateReception' && f[4] === 'dis').length} date(s) de réception + ` +
    `${filled.filter((f) => f[4].includes('CORRIGÉ')).length} date(s) corrigée(s) (artefact d'import) + ` +
    `${filled.filter((f) => f[4] === 'dis' && f[1] !== 'dateReception').length} n° sur les DI + ` +
    `${filled.filter((f) => f[4] === 'logsdis').length} champ(s) logsdis · ${conflicts.length} conflit(s)`,
);
console.log(`Rapport : ${REPORT}`);

if (!APPLY) {
  console.log('DRY-RUN — rien écrit. Relancer avec --apply pour écrire.');
} else {
  if (diOps.length) await db.collection('dis').bulkWrite(diOps, { ordered: false });
  if (logOps.length) await db.collection('logsdis').bulkWrite(logOps, { ordered: false });
  console.log(`APPLIQUÉ : ${diOps.length} DI, ${logOps.length} ligne(s) de cycle mises à jour.`);
}
await client.close();
