import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { spawnSync } from 'child_process';

/**
 * LIVE : lance le VRAI cron (`ACTION=DETECT_STAGNANT_DI`) contre le VRAI
 * classeur (GOOGLE_SHEETS_SPREADSHEET_ID de .env.development), le VRAI Discord
 * APP_ALERT et la VRAIE notification ERP — pour que la feuille du jour se
 * remplisse RÉELLEMENT et que le rappel parte. On purge d'abord les dispatch
 * records du jour (débloque l'idempotence), puis on relit la feuille RÉELLE.
 *
 * Vérifie EN PLUS :
 *   - l'entête FR exacte : « ID : | Statut | Durée | Unité | Message » ;
 *   - la durée RÉELLE écoulée dans le message (« depuis N jours », pas « 24h ») ;
 *   - que TOUS les utilisateurs des rôles cibles (Coordinator / Manager /
 *     Admin_Manager / Admin_Tech) reçoivent bien la notification DAILY_REMINDER.
 *
 * ⚠️ Écrit dans le vrai classeur + poste sur le vrai Discord + crée des
 *    notifications ERP réelles (c'est le but : les voir). Rien n'est nettoyé —
 *    la purge + re-remplissage immédiat garde les dispatch records cohérents
 *    avec la feuille réelle.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { google } = require('/home/skander/Desktop/fx/fix-back/node_modules/googleapis');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MongoClient } = require('mongodb');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dotenv = require('/home/skander/Desktop/fx/fix-back/node_modules/dotenv');

const BACK = '/home/skander/Desktop/fx/fix-back';
const env = dotenv.parse(fs.readFileSync(`${BACK}/.env.development`));
const MONGO = env.MONGODB_URI;
const SHEET = env.GOOGLE_SHEETS_SPREADSHEET_ID;
const HEADER = ['ID :', 'Statut', 'Durée', 'Unité', 'Message'];

// Rôles cibles (humains) → valeurs profil RÉELLES en base (cf. role-mapping.ts ;
// « Coordinator » = coquille COORDIANTOR). Magasin / Tech NON ciblés.
const TARGET_PROFILE_ROLES = [
  'COORDIANTOR',
  'MANAGER',
  'ADMIN_MANAGER',
  'ADMIN_TECH',
];

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());

let sheets: any;

async function withDb<T>(fn: (db: any) => Promise<T>): Promise<T> {
  const c = new MongoClient(MONGO);
  await c.connect();
  try {
    return await fn(c.db());
  } finally {
    await c.close();
  }
}

test.beforeAll(async () => {
  const refreshToken = await withDb(async (db) => {
    const t = await db.collection('oauth_tokens').findOne({});
    return t?.refreshToken as string;
  });
  const o = new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI,
  );
  o.setCredentials({ refresh_token: refreshToken });
  sheets = google.sheets({ version: 'v4', auth: o });
});

test('LIVE : feuille FR remplie + lien profond + TOUS les rôles cibles notifiés', async () => {
  test.setTimeout(240_000);

  // 0) Destinataires ATTENDUS = tous les profils des rôles cibles (même requête
  //    que NotificationService.userIdsForRoles).
  const { expectedIds, byRole, notTargeted } = await withDb(async (db) => {
    const profiles = await db
      .collection('profiles')
      .find({ role: { $in: TARGET_PROFILE_ROLES } }, { projection: { _id: 1, role: 1 } })
      .toArray();
    const byRole: Record<string, number> = {};
    for (const r of TARGET_PROFILE_ROLES) {
      byRole[r] = await db.collection('profiles').countDocuments({ role: r });
    }
    const notTargeted = {
      MAGASIN: await db.collection('profiles').countDocuments({ role: 'MAGASIN' }),
      TECH: await db.collection('profiles').countDocuments({ role: 'TECH' }),
    };
    return {
      expectedIds: profiles.map((p: any) => String(p._id)),
      byRole,
      notTargeted,
    };
  });
  console.log(
    `\n[LIVE] destinataires attendus (rôles cibles) : ${expectedIds.length} — ` +
      Object.entries(byRole)
        .map(([r, n]) => `${r}=${n}`)
        .join(', '),
  );
  console.log(
    `[LIVE] NON ciblés (attendu 0 notif) : MAGASIN=${notTargeted.MAGASIN}, TECH=${notTargeted.TECH}`,
  );
  expect(expectedIds.length, 'au moins un destinataire de rôle cible').toBeGreaterThan(0);

  // 1) Purge des dispatch records du jour → force un run « frais » (l'émission
  //    DAILY_REMINDER refire, les notifications sont recréées pour vérification).
  const beforeMs = Date.now();
  await withDb((db) => db.collection('stagnation_dispatches').deleteMany({ date: today }));

  // 2) VRAI cron — aucune surcharge : classeur + Discord + ERP RÉELS.
  const run = spawnSync('node', ['dist/main.js'], {
    cwd: BACK,
    timeout: 200_000,
    encoding: 'utf-8',
    env: { ...process.env, NODE_ENV: 'development', ACTION: 'DETECT_STAGNANT_DI' },
  });
  expect(
    run.status,
    `ACTION exited ${run.status}\nSTDERR:\n${(run.stderr || '').slice(-2000)}`,
  ).toBe(0);

  // 3) La VRAIE feuille du jour : entête FR + durée RÉELLE (pas « 24 HOURS »).
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET,
    range: `${today}!A:E`,
  });
  const rows = (res.data.values ?? []) as string[][];
  console.log(`\n[LIVE] feuille "${today}" du classeur ${SHEET} : ${rows.length} lignes (entête incluse)`);
  console.log(`[LIVE] entête = ${JSON.stringify(rows[0])}`);
  if (rows[1]) console.log(`[LIVE] 1re ligne = ${JSON.stringify(rows[1])}`);
  expect(rows[0]).toEqual(HEADER);
  expect(rows.length, 'la feuille du jour doit contenir des DI stagnantes').toBeGreaterThan(1);
  // Message FR avec durée réelle : « … depuis N jour(s)/heure(s). », jamais « HOURS ».
  const msg = rows[1]?.[4] ?? '';
  expect(msg).toMatch(/stagnante dans le statut .+ depuis \d+ (jour|jours|heure|heures)\.$/);
  expect(msg).not.toContain('HOURS');
  // Colonne Unité en FR.
  expect(['jour', 'jours', 'heure', 'heures']).toContain(rows[1]?.[3]);

  // 4) Lien PROFOND attendu (gid de l'onglet du jour) — pour cross-check Discord.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET,
    fields: 'sheets.properties(sheetId,title)',
  });
  const gid = meta.data.sheets?.find((s: any) => s.properties?.title === today)?.properties
    ?.sheetId;
  const deepLink = `https://docs.google.com/spreadsheets/d/${SHEET}/edit?gid=${gid}#gid=${gid}`;
  console.log(`[LIVE] lien profond onglet du jour (Discord + cloche) = ${deepLink}`);
  expect(typeof gid).toBe('number');

  // 5) La notification ERP DAILY_REMINDER de CE run + couverture des rôles cibles.
  const coverage = await withDb(async (db) => {
    const event = await db
      .collection('system_events')
      .find({ type: 'DAILY_REMINDER', createdAt: { $gte: new Date(beforeMs) } })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (!event) return { event: null, recipients: [] as string[] };
    const notifs = await db
      .collection('notifications')
      .find({ eventId: String(event._id), type: 'DAILY_REMINDER' })
      .project({ userId: 1 })
      .toArray();
    return {
      event,
      recipients: [...new Set(notifs.map((n: any) => String(n.userId)))],
    };
  });
  expect(coverage.event, 'un system_event DAILY_REMINDER émis par ce run').toBeTruthy();

  const expectedSet = new Set(expectedIds);
  const recvSet = new Set(coverage.recipients);
  const missing = [...expectedSet].filter((id) => !recvSet.has(id));
  const extra = [...recvSet].filter((id) => !expectedSet.has(id));
  console.log(
    `[LIVE] notifiés = ${recvSet.size}/${expectedSet.size} attendus · ` +
      `manquants=${missing.length} · en trop=${extra.length}`,
  );
  console.log(
    `[LIVE] payload.url cloche = ${JSON.stringify((coverage.event as any)?.payload?.url)}`,
  );

  // TOUS les utilisateurs des rôles cibles reçoivent la notification…
  expect(missing, `utilisateurs cibles SANS notification : ${missing.join(', ')}`).toEqual([]);
  // …et PERSONNE d'autre (Magasin/Tech exclus).
  expect(extra, `utilisateurs notifiés HORS cible : ${extra.join(', ')}`).toEqual([]);
  // La cloche porte le lien profond vers la feuille.
  expect((coverage.event as any)?.payload?.url).toBe(deepLink);
});
