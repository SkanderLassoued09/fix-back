import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { JiraCronNotificationService } from './jira-cron-notification.service';
import { JiraService } from 'src/jira/jira.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';

/**
 * Unit tests, fully isolated from the runner + the network:
 *   - Cron 1 (`syncTaches`): Jira client MOCKED; an in-memory model reproduces
 *     `updateOne(..., { $setOnInsert }, { upsert:true })`; `todayTunis()` pinned
 *     so the daily dedupeKey (`issueKey:YYYY-MM-DD`) is deterministic.
 *   - Cron 2 (`envoyerNotifications`): Discord MOCKED; an in-memory model
 *     reproduces find / atomic findOneAndUpdate / updateMany. NO Jira call.
 */

const TODAY = '2026-06-29';
const TOMORROW = '2026-06-30';

type Row = Record<string, any>;

// ── Model for Cron 1 (upsert-by-dedupeKey) ──────────────────────────────
function makeModel(seed: Row[] = []) {
  const store = new Map<string, Row>();
  for (const r of seed) store.set(r.dedupeKey, { ...r });
  return {
    store,
    updateOne: jest.fn(async (filter: any, update: any, opts: any) => {
      const key = filter.dedupeKey;
      if (store.has(key)) {
        return { acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null };
      }
      if (opts?.upsert && update?.$setOnInsert) {
        store.set(key, { ...update.$setOnInsert });
        return { acknowledged: true, matchedCount: 0, upsertedCount: 1, upsertedId: key };
      }
      return { acknowledged: true, matchedCount: 0, upsertedCount: 0, upsertedId: null };
    }),
  };
}

// ── Model for Cron 2 (find / findOneAndUpdate / updateMany, keyed by _id) ─
function makeNotifModel(seed: Row[] = []) {
  let idc = 0;
  const store = new Map<string, Row>();
  for (const r of seed) {
    const _id = r._id ?? `id${++idc}`;
    store.set(_id, { attempts: 0, source: 'JIRA', status: 'PENDING', ...r, _id });
  }
  const match = (d: Row, f: any): boolean => {
    if (f.status !== undefined && d.status !== f.status) return false;
    if (f._id !== undefined) {
      if (f._id && typeof f._id === 'object' && Array.isArray(f._id.$in)) {
        if (!f._id.$in.includes(d._id)) return false;
      } else if (d._id !== f._id) return false;
    }
    return true;
  };
  const apply = (d: Row, update: any) => {
    if (update.$set) Object.assign(d, update.$set);
    if (update.$inc) for (const k of Object.keys(update.$inc)) d[k] = (d[k] ?? 0) + update.$inc[k];
  };
  return {
    store,
    find: jest.fn((filter: any) => ({
      lean: () =>
        Promise.resolve([...store.values()].filter((d) => match(d, filter)).map((d) => ({ ...d }))),
    })),
    findOneAndUpdate: jest.fn(async (filter: any, update: any, opts: any) => {
      const doc = [...store.values()].find((d) => match(d, filter));
      if (!doc) return null; // already claimed / not matching → atomic skip
      apply(doc, update);
      return opts?.new ? { ...doc } : null;
    }),
    updateMany: jest.fn(async (filter: any, update: any) => {
      const docs = [...store.values()].filter((d) => match(d, filter));
      docs.forEach((d) => apply(d, update));
      return { matchedCount: docs.length, modifiedCount: docs.length };
    }),
  };
}

function makeJira(): { isConfigured: boolean; searchIssues: jest.Mock } {
  return { isConfigured: true, searchIssues: jest.fn() };
}

function makeDiscord(): { isPvConfigured: boolean; sendJiraTasksDigest: jest.Mock } {
  return { isPvConfigured: true, sendJiraTasksDigest: jest.fn().mockResolvedValue(undefined) };
}

const issue = (key: string, over: Partial<Row> = {}): Row => ({
  issueKey: key,
  titre: `Tâche ${key}`,
  responsable: 'tech@fixtronix.tn',
  echeance: new Date('2026-06-30'),
  url: `https://jira.example/browse/${key}`,
  ...over,
});

async function build(
  model: any,
  jira: any,
  day: string = TODAY,
  discord: any = makeDiscord(),
): Promise<JiraCronNotificationService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      JiraCronNotificationService,
      { provide: getModelToken('JiraCronNotification'), useValue: model },
      { provide: JiraService, useValue: jira },
      { provide: DiscordHookService, useValue: discord },
    ],
  }).compile();
  const svc = moduleRef.get(JiraCronNotificationService);
  jest.spyOn(svc as any, 'todayTunis').mockReturnValue(day);
  return svc;
}

describe('JiraCronNotificationService.syncTaches (SYNC_JIRA_TASKS)', () => {
  it('2 issues TODO proches échéance → 2 PENDING (clé issueKey:today) + JQL statut ouvert', async () => {
    const model = makeModel();
    const jira = makeJira();
    jira.searchIssues.mockResolvedValue([issue('FIX-1'), issue('FIX-2')]);
    const svc = await build(model, jira, TODAY);

    const res = await svc.syncTaches();

    expect(res).toMatchObject({ fetched: 2, inserted: 2 });
    expect(model.store.has(`FIX-1:${TODAY}`)).toBe(true);
    expect(model.store.has(`FIX-2:${TODAY}`)).toBe(true);
    expect(model.store.get(`FIX-1:${TODAY}`)).toMatchObject({
      status: 'PENDING',
      source: 'JIRA',
      issueKey: 'FIX-1',
      dedupeKey: `FIX-1:${TODAY}`,
    });
    expect(jira.searchIssues).toHaveBeenCalledWith(
      expect.stringContaining('statusCategory in ("To Do", "In Progress")'),
    );
  });

  it('re-run même jour, mêmes issues → AUCUN nouveau doc (dédup clé du jour)', async () => {
    const model = makeModel();
    const jira = makeJira();
    jira.searchIssues.mockResolvedValue([issue('FIX-1'), issue('FIX-2')]);
    const svc = await build(model, jira, TODAY);

    await svc.syncTaches();
    const res2 = await svc.syncTaches();

    expect(res2).toMatchObject({ fetched: 2, inserted: 0 });
    expect(model.store.size).toBe(2);
  });

  it('jour suivant, issue toujours ouverte → nouveau doc PENDING (re-nudge)', async () => {
    const model = makeModel();
    const jira = makeJira();
    jira.searchIssues.mockResolvedValue([issue('FIX-1')]);

    const svcDay1 = await build(model, jira, TODAY);
    await svcDay1.syncTaches();
    expect(model.store.has(`FIX-1:${TODAY}`)).toBe(true);
    expect(model.store.size).toBe(1);

    const svcDay2 = await build(model, jira, TOMORROW);
    const res = await svcDay2.syncTaches();

    expect(res.inserted).toBe(1);
    expect(model.store.has(`FIX-1:${TOMORROW}`)).toBe(true);
    expect(model.store.size).toBe(2);
  });

  it('issue déjà PROCESSED le même jour + re-run → reste PROCESSED', async () => {
    const model = makeModel([
      { dedupeKey: `FIX-1:${TODAY}`, issueKey: 'FIX-1', status: 'PROCESSED', source: 'JIRA' },
    ]);
    const jira = makeJira();
    jira.searchIssues.mockResolvedValue([issue('FIX-1')]);
    const svc = await build(model, jira, TODAY);

    const res = await svc.syncTaches();

    expect(res.inserted).toBe(0);
    expect(model.store.get(`FIX-1:${TODAY}`).status).toBe('PROCESSED');
  });

  it('erreur API Jira → pas de crash, 0 insertion', async () => {
    const model = makeModel();
    const jira = makeJira();
    jira.searchIssues.mockRejectedValue(new Error('Jira 503'));
    const svc = await build(model, jira, TODAY);

    const res = await svc.syncTaches();

    expect(res.inserted).toBe(0);
    expect(res.error).toMatch(/Jira 503/);
    expect(model.store.size).toBe(0);
  });
});

describe('JiraCronNotificationService.envoyerNotifications (SYNC_JIRA_DUE_SOON)', () => {
  it('3 PENDING (2 responsables) → 1 notif Discord groupée → les 3 PROCESSED, AUCUN appel Jira', async () => {
    const model = makeNotifModel([
      { _id: '1', issueKey: 'FIX-1', titre: 'A', responsable: 'alice@x', status: 'PENDING' },
      { _id: '2', issueKey: 'FIX-2', titre: 'B', responsable: 'alice@x', status: 'PENDING' },
      { _id: '3', issueKey: 'FIX-3', titre: 'C', responsable: 'bob@x', status: 'PENDING' },
    ]);
    const jira = makeJira();
    const discord = makeDiscord();
    const svc = await build(model, jira, TODAY, discord);

    const res = await svc.envoyerNotifications();

    expect(res).toMatchObject({ claimed: 3, processed: 3, failed: 0 });
    // UNE seule notif groupée portant les 3 tâches.
    expect(discord.sendJiraTasksDigest).toHaveBeenCalledTimes(1);
    const items = discord.sendJiraTasksDigest.mock.calls[0][0];
    expect(items).toHaveLength(3);
    // 2 responsables distincts (sectionnable).
    expect(new Set(items.map((i: any) => i.responsable)).size).toBe(2);
    // Tous PROCESSED.
    expect([...model.store.values()].every((d: any) => d.status === 'PROCESSED')).toBe(true);
    // Cron 2 ne touche JAMAIS Jira.
    expect(jira.searchIssues).not.toHaveBeenCalled();
  });

  it('re-run → aucun PENDING restant → no-op, pas de nouvel envoi (idempotent)', async () => {
    const model = makeNotifModel([
      { _id: '1', issueKey: 'FIX-1', responsable: 'a', status: 'PENDING' },
    ]);
    const jira = makeJira();
    const discord = makeDiscord();
    const svc = await build(model, jira, TODAY, discord);

    await svc.envoyerNotifications();
    discord.sendJiraTasksDigest.mockClear();
    const res2 = await svc.envoyerNotifications();

    expect(res2).toMatchObject({ claimed: 0, processed: 0, failed: 0 });
    expect(discord.sendJiraTasksDigest).not.toHaveBeenCalled();
    expect(model.store.get('1').status).toBe('PROCESSED');
  });

  it('échec Discord → docs restent PENDING, attempts++, pas PROCESSED', async () => {
    const model = makeNotifModel([
      { _id: '1', issueKey: 'FIX-1', responsable: 'a', status: 'PENDING', attempts: 0 },
      { _id: '2', issueKey: 'FIX-2', responsable: 'b', status: 'PENDING', attempts: 0 },
    ]);
    const jira = makeJira();
    const discord = makeDiscord();
    discord.sendJiraTasksDigest.mockRejectedValue(new Error('Discord 500'));
    const svc = await build(model, jira, TODAY, discord);

    const res = await svc.envoyerNotifications();

    expect(res).toMatchObject({ claimed: 2, processed: 0, failed: 2 });
    expect(res.error).toMatch(/Discord 500/);
    for (const d of model.store.values()) {
      expect(d.status).toBe('PENDING'); // reverted, pas perdus
      expect(d.attempts).toBe(1); // incrémenté
      expect(d.lastError).toMatch(/Discord 500/);
    }
  });

  it('après JIRA_NOTIF_MAX_ATTEMPTS échecs → FAILED (stoppe la boucle)', async () => {
    process.env.JIRA_NOTIF_MAX_ATTEMPTS = '3';
    // attempts=2 → cette tentative est la 3e = max → FAILED
    const model = makeNotifModel([
      { _id: '1', issueKey: 'FIX-1', responsable: 'a', status: 'PENDING', attempts: 2 },
    ]);
    const jira = makeJira();
    const discord = makeDiscord();
    discord.sendJiraTasksDigest.mockRejectedValue(new Error('Discord down'));
    const svc = await build(model, jira, TODAY, discord);

    await svc.envoyerNotifications();

    expect(model.store.get('1').status).toBe('FAILED');
    delete process.env.JIRA_NOTIF_MAX_ATTEMPTS;
  });

  it('Discord non configuré → skipped, rien claimé, aucun envoi', async () => {
    const model = makeNotifModel([
      { _id: '1', issueKey: 'FIX-1', responsable: 'a', status: 'PENDING' },
    ]);
    const jira = makeJira();
    const discord = makeDiscord();
    discord.isPvConfigured = false;
    const svc = await build(model, jira, TODAY, discord);

    const res = await svc.envoyerNotifications();

    expect(res).toMatchObject({ skipped: true, claimed: 0 });
    expect(model.store.get('1').status).toBe('PENDING'); // intouché
    expect(discord.sendJiraTasksDigest).not.toHaveBeenCalled();
  });

  it('un doc déjà PROCESSING (claimé par une autre exécution) n’est pas re-notifié', async () => {
    const model = makeNotifModel([
      { _id: '1', issueKey: 'FIX-1', responsable: 'a', status: 'PENDING' },
      { _id: '2', issueKey: 'FIX-2', responsable: 'b', status: 'PROCESSING' }, // déjà claimé ailleurs
    ]);
    const jira = makeJira();
    const discord = makeDiscord();
    const svc = await build(model, jira, TODAY, discord);

    const res = await svc.envoyerNotifications();

    expect(res).toMatchObject({ claimed: 1, processed: 1 });
    const items = discord.sendJiraTasksDigest.mock.calls[0][0];
    expect(items.map((i: any) => i.issueKey)).toEqual(['FIX-1']);
    expect(model.store.get('1').status).toBe('PROCESSED');
    expect(model.store.get('2').status).toBe('PROCESSING'); // pas touché
  });
});
