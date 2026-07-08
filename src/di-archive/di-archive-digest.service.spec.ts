import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { DiArchiveDigestService } from './di-archive-digest.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';

/**
 * Unit tests for DiArchiveDigestService — enriched target format.
 *
 * Guards:
 *  - Completude % correct (rounded)
 *  - Missing-doc counters correct
 *  - Emojis + labels conform to the target format (🔴 Facture with
 *    « ⚠️ facturation à risque », 🟠 BC, 🟠 BL, 🟡 Devis)
 *  - Day trend arrow reacts to the previous snapshot
 *  - « (première mesure) » when no snapshot exists
 *  - Weekly progress line surfaces when a ~7d snapshot exists AND delta > 0
 *  - Weekly progress line is OMITTED when non-positive
 *  - Snapshot upsert is idempotent
 *  - Discord posts to APP_ALERT
 *  - Zero incompletes case
 *  - NO write on DiArchive (read-only invariant)
 */

type DiArchiveMock = {
  countDocuments: jest.Mock;
  find: jest.Mock;
  updateOne: jest.Mock;
  updateMany: jest.Mock;
  deleteOne: jest.Mock;
  save: jest.Mock;
};

type SnapshotMock = {
  findOne: jest.Mock;
  updateOne: jest.Mock;
};

const makeDiArchive = (): DiArchiveMock => ({
  countDocuments: jest.fn().mockResolvedValue(0),
  find: jest.fn(() => ({ lean: () => Promise.resolve([]) })),
  updateOne: jest.fn(() => {
    throw new Error('READ-ONLY VIOLATION: updateOne on DiArchive');
  }),
  updateMany: jest.fn(() => {
    throw new Error('READ-ONLY VIOLATION: updateMany on DiArchive');
  }),
  deleteOne: jest.fn(() => {
    throw new Error('READ-ONLY VIOLATION: deleteOne on DiArchive');
  }),
  save: jest.fn(() => {
    throw new Error('READ-ONLY VIOLATION: save on DiArchive');
  }),
});

const makeSnapshot = (): SnapshotMock => {
  const store: any[] = [];
  return {
    findOne: jest.fn(() => ({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    })),
    updateOne: jest.fn(async (filter: any, update: any, options: any) => {
      // Persist a rough approximation so idempotence tests can inspect it.
      const idx = store.findIndex(
        (s) => +new Date(s.date) === +new Date(filter.date),
      );
      const payload = { ...(update?.$set || {}), ...(update?.$setOnInsert || {}) };
      if (idx >= 0) {
        Object.assign(store[idx], payload);
      } else if (options?.upsert) {
        store.push({ date: filter.date, ...payload });
      }
      (globalThis as any).__snapshotStore = store;
      return { acknowledged: true, upsertedCount: idx >= 0 ? 0 : 1 };
    }),
  };
};

describe('DiArchiveDigestService (enriched)', () => {
  let service: DiArchiveDigestService;
  let diArchive: DiArchiveMock;
  let snapshot: SnapshotMock;
  let discord: { postEmbed: jest.Mock };

  beforeEach(async () => {
    diArchive = makeDiArchive();
    snapshot = makeSnapshot();
    discord = { postEmbed: jest.fn().mockResolvedValue(undefined) };
    (globalThis as any).__snapshotStore = [];

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        DiArchiveDigestService,
        { provide: getModelToken('DiArchive'), useValue: diArchive },
        { provide: getModelToken('DigestSnapshot'), useValue: snapshot },
        { provide: DiscordHookService, useValue: discord },
      ],
    }).compile();
    service = moduleRef.get(DiArchiveDigestService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('computes completude % correctly (rounded)', async () => {
    diArchive.countDocuments.mockResolvedValue(1334);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          // 373 incompletes — pct = round((1334-373)/1334*100) = 72
          Array.from({ length: 373 }, (_, i) => ({
            bc: i % 2 ? {} : null,
            bl: {},
            devis: {},
            facture: null,
          })),
        ),
    });

    const res = await service.buildAndSend();
    expect(res.total).toBe(1334);
    expect(res.totalIncompletes).toBe(373);
    expect(res.completudePct).toBe(72);
  });

  it('counts missing docs correctly per incomplet row', async () => {
    diArchive.countDocuments.mockResolvedValue(4);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { bc: null, bl: {}, devis: {}, facture: null }, // fact+bc
          { bc: {}, bl: {}, devis: null, facture: null }, // fact+devis
          { bc: {}, bl: {}, devis: {}, facture: null }, // fact
          { bc: {}, bl: null, devis: {}, facture: {} }, // bl
        ]),
    });
    const res = await service.buildAndSend();
    expect(res.missing).toEqual({
      facture: 3,
      bc: 1,
      bl: 1,
      devis: 1,
    });
  });

  it('routes to APP_ALERT with the target emojis + « facturation à risque » label', async () => {
    diArchive.countDocuments.mockResolvedValue(100);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { bc: {}, bl: {}, devis: {}, facture: null },
          { bc: {}, bl: {}, devis: {}, facture: null },
        ]),
    });

    await service.buildAndSend();
    const [channel, payload] = discord.postEmbed.mock.calls[0];
    expect(channel).toBe('APP_ALERT');
    const desc: string = payload?.embeds?.[0]?.description ?? '';
    // Fixed emojis per doc
    expect(desc).toContain('🔴');
    expect(desc).toContain('Facture');
    expect(desc).toContain('🟠 BC');
    expect(desc).toContain('🟠 BL');
    expect(desc).toContain('🟡 Devis');
    // Static risk label on facture line only
    expect(desc).toContain('⚠️ facturation à risque');
    // Code block for alignment
    expect(desc).toContain('```');
    // Title matches the target
    expect(payload?.embeds?.[0]?.title).toBe(
      '📊 FIXTRONIX · Suivi documentaire DiArchive',
    );
    // Amber color constant
    expect(payload?.embeds?.[0]?.color).toBe(16289308);
  });

  it('renders « ▼ N depuis hier » when yesterday snapshot has more incompletes (improvement)', async () => {
    diArchive.countDocuments.mockResolvedValue(1000);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          Array.from({ length: 100 }, () => ({
            bc: null,
            bl: {},
            devis: {},
            facture: {},
          })),
        ),
    });
    // previous snapshot lookup (day trend) → 127 incompletes yesterday
    snapshot.findOne
      .mockReturnValueOnce({
        sort: () => ({
          lean: () => Promise.resolve({ totalIncompletes: 127, date: new Date() }),
        }),
      })
      // week trend lookup → none
      .mockReturnValueOnce({
        sort: () => ({ lean: () => Promise.resolve(null) }),
      });

    const res = await service.buildAndSend();
    expect(res.trendDay).toBe(27);
    const desc: string = discord.postEmbed.mock.calls[0][1].embeds[0].description;
    expect(desc).toContain('▼ 27 depuis hier');
  });

  it('renders « ▲ N depuis hier » when incompletes increased (regression)', async () => {
    diArchive.countDocuments.mockResolvedValue(1000);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          Array.from({ length: 150 }, () => ({
            bc: null,
            bl: {},
            devis: {},
            facture: {},
          })),
        ),
    });
    snapshot.findOne
      .mockReturnValueOnce({
        sort: () => ({
          lean: () => Promise.resolve({ totalIncompletes: 120, date: new Date() }),
        }),
      })
      .mockReturnValueOnce({
        sort: () => ({ lean: () => Promise.resolve(null) }),
      });

    const res = await service.buildAndSend();
    expect(res.trendDay).toBe(-30);
    const desc: string = discord.postEmbed.mock.calls[0][1].embeds[0].description;
    expect(desc).toContain('▲ 30 depuis hier');
  });

  it('renders « (première mesure) » when no previous snapshot exists', async () => {
    diArchive.countDocuments.mockResolvedValue(500);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          Array.from({ length: 50 }, () => ({
            bc: null,
            bl: {},
            devis: {},
            facture: {},
          })),
        ),
    });
    // both findOne (day + week) return null
    snapshot.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });

    const res = await service.buildAndSend();
    expect(res.trendDay).toBeNull();
    expect(res.trendWeek).toBeNull();
    const desc: string = discord.postEmbed.mock.calls[0][1].embeds[0].description;
    expect(desc).toContain('(première mesure)');
    // Weekly progress line is omitted when null
    expect(desc).not.toContain('🎯 En bonne voie');
  });

  it('renders « 🎯 En bonne voie : N complétées cette semaine » when weekly delta is positive', async () => {
    diArchive.countDocuments.mockResolvedValue(1000);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          Array.from({ length: 100 }, () => ({
            bc: null,
            bl: {},
            devis: {},
            facture: {},
          })),
        ),
    });
    // day trend null, week trend 145 → 45 completed this week
    snapshot.findOne
      .mockReturnValueOnce({
        sort: () => ({ lean: () => Promise.resolve(null) }),
      })
      .mockReturnValueOnce({
        sort: () => ({
          lean: () =>
            Promise.resolve({ totalIncompletes: 145, date: new Date() }),
        }),
      });

    const res = await service.buildAndSend();
    expect(res.trendWeek).toBe(45);
    const desc: string = discord.postEmbed.mock.calls[0][1].embeds[0].description;
    expect(desc).toContain('🎯 En bonne voie : 45 DI complétées cette semaine');
  });

  it('omits the weekly line when delta is zero or negative (silence over false-win)', async () => {
    diArchive.countDocuments.mockResolvedValue(1000);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          Array.from({ length: 100 }, () => ({
            bc: null,
            bl: {},
            devis: {},
            facture: {},
          })),
        ),
    });
    snapshot.findOne
      .mockReturnValueOnce({
        sort: () => ({ lean: () => Promise.resolve(null) }),
      })
      // week snapshot with 90 (LESS than today's 100) → delta -10 → omit
      .mockReturnValueOnce({
        sort: () => ({
          lean: () => Promise.resolve({ totalIncompletes: 90, date: new Date() }),
        }),
      });

    await service.buildAndSend();
    const desc: string = discord.postEmbed.mock.calls[0][1].embeds[0].description;
    expect(desc).not.toContain('🎯 En bonne voie');
  });

  it('upserts today\'s snapshot with the freshly computed metrics', async () => {
    diArchive.countDocuments.mockResolvedValue(1334);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          Array.from({ length: 373 }, () => ({
            bc: {},
            bl: {},
            devis: {},
            facture: null,
          })),
        ),
    });

    await service.buildAndSend();
    expect(snapshot.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = snapshot.updateOne.mock.calls[0];
    expect(filter).toHaveProperty('date');
    expect(options).toEqual({ upsert: true });
    expect(update.$set).toMatchObject({
      totalDiArchive: 1334,
      totalIncompletes: 373,
      completudePct: 72,
      missingFacture: 373,
    });
  });

  it('is idempotent — 2 runs the same day → 1 snapshot doc', async () => {
    diArchive.countDocuments.mockResolvedValue(100);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { bc: {}, bl: {}, devis: {}, facture: null },
        ]),
    });
    await service.buildAndSend();
    await service.buildAndSend();
    const store = (globalThis as any).__snapshotStore;
    // Both runs targeted the same `date` key → mock upsert reused the row.
    expect(store).toHaveLength(1);
    expect(snapshot.updateOne).toHaveBeenCalledTimes(2);
  });

  it('handles zero incompletes cleanly (100% completude, no weekly line)', async () => {
    diArchive.countDocuments.mockResolvedValue(500);
    diArchive.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    snapshot.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });
    const res = await service.buildAndSend();
    expect(res.totalIncompletes).toBe(0);
    expect(res.completudePct).toBe(100);
    const desc: string = discord.postEmbed.mock.calls[0][1].embeds[0].description;
    expect(desc).toContain('100%');
    expect(desc).toContain('🎉 0 DI incomplète');
  });

  it('handles empty archive (total=0) without divide-by-zero', async () => {
    diArchive.countDocuments.mockResolvedValue(0);
    diArchive.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    snapshot.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });
    const res = await service.buildAndSend();
    expect(res.total).toBe(0);
    expect(res.completudePct).toBe(100);
  });

  it('performs NO write on DiArchive (only DigestSnapshot is touched)', async () => {
    diArchive.countDocuments.mockResolvedValue(3);
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { bc: null, bl: null, devis: null, facture: null },
        ]),
    });
    await service.buildAndSend();
    expect(diArchive.updateOne).not.toHaveBeenCalled();
    expect(diArchive.updateMany).not.toHaveBeenCalled();
    expect(diArchive.deleteOne).not.toHaveBeenCalled();
    expect(diArchive.save).not.toHaveBeenCalled();
    // Snapshot IS written — that's the one allowed write.
    expect(snapshot.updateOne).toHaveBeenCalledTimes(1);
  });
});
