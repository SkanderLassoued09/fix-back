import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { spawnSync } from 'child_process';

/**
 * Bout-en-bout du RAPPORT QUOTIDIEN DE STAGNATION : on lance le VRAI cron via
 * son point d'entrée manuel `ACTION=DETECT_STAGNANT_DI` (même méthode que le
 * `@Cron` de 08:00), puis on RELIT la feuille Google pour vérifier qu'elle est
 * remplie comme attendu (onglet = date du jour, entête exact, ligne de la DI
 * stagnante, idempotence).
 *
 * ISOLATION : le cron écrit dans un classeur JETABLE créé pour le test (override
 * `GOOGLE_SHEETS_SPREADSHEET_ID` via l'env du process enfant — dotenv est en
 * `override:false`), pas dans le vrai classeur. Discord est neutralisé
 * (`DISCORD_APP_ALERT_WEBHOOK=''` → post ignoré). Tout est nettoyé en fin.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { google } = require('/home/skander/Desktop/fx/fix-back/node_modules/googleapis');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MongoClient } = require('mongodb');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dotenv = require('/home/skander/Desktop/fx/fix-back/node_modules/dotenv');

const BACK = '/home/skander/Desktop/fx/fix-back';
const ENV_FILE = `${BACK}/.env.development`;
const TAG = Date.now().toString(36);
const DI_ID = `DI_SHEETQA_${TAG}`;
const DI_IDNUM = `SHEETQA-${TAG}`;
const HEADER = ['ID :', 'Statut', 'Durée', 'Unité', 'Message'];

function parseEnv(): Record<string, string> {
  return dotenv.parse(fs.readFileSync(ENV_FILE));
}

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(
    new Date(),
  );
}

const env = parseEnv();
const MONGO = env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fixtronixproddb';
let sheets: any;
let drive: any;
let throwawayId = '';

async function withDb<T>(fn: (db: any) => Promise<T>): Promise<T> {
  const client = new MongoClient(MONGO);
  await client.connect();
  try {
    return await fn(client.db());
  } finally {
    await client.close();
  }
}

function runCron() {
  return spawnSync('node', ['dist/main.js'], {
    cwd: BACK,
    timeout: 120_000,
    encoding: 'utf-8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ACTION: 'DETECT_STAGNANT_DI',
      // Isolation : classeur jetable + Discord neutralisé (dotenv n'écrase pas).
      GOOGLE_SHEETS_SPREADSHEET_ID: throwawayId,
      DISCORD_APP_ALERT_WEBHOOK: '',
    },
  });
}

test.beforeAll(async () => {
  // 1) Client Google via l'OAuth2 EXISTANT (client id/secret depuis .env,
  //    refresh token depuis Mongo oauth_tokens — aucun service account).
  const refreshToken = await withDb(async (db) => {
    const t = await db.collection('oauth_tokens').findOne({});
    return t?.refreshToken as string;
  });
  if (!refreshToken) throw new Error('No oauth_tokens.refreshToken — run GET /auth/google');
  const oauth2 = new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI,
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  sheets = google.sheets({ version: 'v4', auth: oauth2 });
  drive = google.drive({ version: 'v3', auth: oauth2 });

  // 2) Classeur JETABLE (isolation totale du vrai classeur).
  const created = await sheets.spreadsheets.create({
    requestBody: { properties: { title: `QA-STAGNATION-${TAG}` } },
  });
  throwawayId = created.data.spreadsheetId;

  // 3) Une DI stagnante (25h dans le MÊME statut) + non terminale + ouverte.
  await withDb(async (db) => {
    await db.collection('dis').insertOne({
      _id: DI_ID,
      _idnum: DI_IDNUM,
      title: 'QA stagnation sheet',
      status: 'WAITING_DEVIS',
      isDeleted: false,
      // 73h dans le même statut → « 3 jours » pleins (assertion nette).
      statusUpdatedAt: new Date(Date.now() - 73 * 3600_000),
      updatedAt: new Date(Date.now() - 73 * 3600_000),
      createdAt: new Date(Date.now() - 200 * 3600_000),
    });
  });
});

test.afterAll(async () => {
  if (throwawayId) {
    try {
      await drive.files.delete({ fileId: throwawayId });
    } catch {
      /* best-effort */
    }
  }
  await withDb(async (db) => {
    await db.collection('dis').deleteOne({ _id: DI_ID });
    await db.collection('stagnation_dispatches').deleteMany({ idNum: DI_IDNUM });
    await db.collection('notifications').deleteMany({ diId: DI_ID });
  });
});

async function readTodaySheet(): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: throwawayId,
    range: `${today()}!A:E`,
  });
  return (res.data.values ?? []) as string[][];
}

test('le cron remplit la feuille du jour (onglet, entête, ligne DI) + idempotent', async () => {
  test.setTimeout(300_000); // 2 boots Nest (ACTION) + appels Google API
  // === RUN 1 : le vrai cron ===
  const r1 = runCron();
  expect(
    r1.status,
    `ACTION exited ${r1.status}\nSTDERR:\n${(r1.stderr || '').slice(-1500)}`,
  ).toBe(0);

  const rows1 = await readTodaySheet();
  // Onglet du jour créé + entête EXACT.
  expect(rows1.length, 'la feuille du jour doit exister avec au moins l’entête + 1 ligne').toBeGreaterThanOrEqual(2);
  expect(rows1[0]).toEqual(HEADER);

  // Ligne de NOTRE DI stagnante.
  const mine = rows1.filter((r) => r[0] === DI_IDNUM);
  expect(mine, `ligne de ${DI_IDNUM} attendue dans l’onglet ${today()}`).toHaveLength(1);
  expect(mine[0][1]).toBe('WAITING_DEVIS'); // Statut
  expect(mine[0][2]).toBe('3'); // Durée réelle (73h → 3 jours pleins)
  expect(mine[0][3]).toBe('jours'); // Unité FR adaptée
  expect(mine[0][4]).toContain('stagnante'); // Message FR
  expect(mine[0][4]).toContain(DI_IDNUM);
  expect(mine[0][4]).toContain('depuis 3 jours'); // durée réelle, pas « 24h »

  // Enregistrement d'idempotence créé en base.
  const dispatched = await withDb((db) =>
    db.collection('stagnation_dispatches').countDocuments({
      date: today(),
      idNum: DI_IDNUM,
      status: 'WAITING_DEVIS',
    }),
  );
  expect(dispatched, 'un dispatch record {date,idNum,status}').toBe(1);

  // === RUN 2 (retry le même jour) : AUCUN doublon ===
  const r2 = runCron();
  expect(r2.status, `2e ACTION exited ${r2.status}`).toBe(0);

  const rows2 = await readTodaySheet();
  const mine2 = rows2.filter((r) => r[0] === DI_IDNUM);
  expect(mine2, 'toujours UNE seule ligne après re-run (idempotent)').toHaveLength(1);
});
