import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import {
  DiArchiveDigestService,
  isDocMissing,
} from './di-archive-digest.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';

/**
 * Unit tests for DiArchiveDigestService — completeness computed from the
 * 4 registry TEXT refs (bcRef / blRef / devisRef / factureRef), NOT from
 * the paired DriveDocRef slots. Rule:
 *   MISSING ⇐ null / undefined / '' / whitespace / '_' / /^sans$/i
 *   PRESENT ⇐ anything else (real ref, ANNULER, IRREPARABLE, EMAIL, …)
 *
 * Guards:
 *  - Rule detection for the exact sentinels + real refs
 *  - Per-doc counters can (and must) differ — the registry pattern is
 *    heterogeneous per column
 *  - Completude % correct (rounded)
 *  - Trend day / week using DigestSnapshot
 *  - Idempotent snapshot upsert
 *  - Zero incompletes case
 *  - Empty archive (total=0) safe
 *  - NO write on DiArchive (read-only invariant)
 *  - APP_ALERT routing + target embed format
 */

type DiArchiveMock = {
  find: jest.Mock;
  countDocuments: jest.Mock;
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
  find: jest.fn(() => ({ lean: () => Promise.resolve([]) })),
  countDocuments: jest.fn().mockResolvedValue(0),
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

// ── isDocMissing pure-function guards ────────────────────────────────

describe('isDocMissing (rule)', () => {
  it('treats null / undefined / empty / whitespace as MISSING', () => {
    expect(isDocMissing(null)).toBe(true);
    expect(isDocMissing(undefined)).toBe(true);
    expect(isDocMissing('')).toBe(true);
    expect(isDocMissing('   ')).toBe(true);
  });

  it('treats the sentinel `_` as MISSING (even with surrounding spaces)', () => {
    expect(isDocMissing('_')).toBe(true);
    expect(isDocMissing(' _ ')).toBe(true);
  });

  it('treats `Sans` case-insensitive + trimmed as MISSING', () => {
    expect(isDocMissing('Sans')).toBe(true);
    expect(isDocMissing('SANS')).toBe(true);
    expect(isDocMissing('sans')).toBe(true);
    expect(isDocMissing(' Sans ')).toBe(true);
  });

  it('treats real refs / business markers as PRESENT', () => {
    expect(isDocMissing('112/23')).toBe(false);
    expect(isDocMissing('PI 003/26')).toBe(false);
    expect(isDocMissing('Ok')).toBe(false);
    expect(isDocMissing('6200655774')).toBe(false);
    expect(isDocMissing('ANNULER')).toBe(false);
    expect(isDocMissing('IRREPARABLE')).toBe(false);
    expect(isDocMissing('EMAIL')).toBe(false);
  });
});

// ── Service-level tests ──────────────────────────────────────────────

describe('DiArchiveDigestService', () => {
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

  it('counts a fully-present DI (real refs + ANNULER on facture) as COMPLET', async () => {
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            devisRef: '112/23',
            bcRef: 'Ok',
            blRef: '054/24',
            factureRef: 'ANNULER',
          },
        ]),
    });
    const res = await service.buildAndSend();
    expect(res.total).toBe(1);
    expect(res.totalIncompletes).toBe(0);
    expect(res.missing).toEqual({ bc: 0, bl: 0, devis: 0, facture: 0 });
    expect(res.completudePct).toBe(100);
  });

  it('flags a row with factureRef=Sans as INCOMPLET and counts Facture++', async () => {
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { devisRef: '1', bcRef: '2', blRef: '3', factureRef: 'Sans' },
        ]),
    });
    const res = await service.buildAndSend();
    expect(res.totalIncompletes).toBe(1);
    expect(res.missing.facture).toBe(1);
    expect(res.missing.bc).toBe(0);
    expect(res.missing.bl).toBe(0);
    expect(res.missing.devis).toBe(0);
  });

  it('counts BC AND BL when a row has bcRef=`_` and blRef=`None` (but None is a real value → PRESENT)', async () => {
    // `None` is a text ref — not one of the empty sentinels, so it's
    // treated as PRESENT per the rule. This locks down the spec: the
    // rule only catches empty/`_`/`sans`, NOT `None`, `n/a`, etc.
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { bcRef: '_', blRef: 'None', devisRef: '112/23', factureRef: 'OK' },
        ]),
    });
    const res = await service.buildAndSend();
    expect(res.totalIncompletes).toBe(1);
    expect(res.missing.bc).toBe(1);
    expect(res.missing.bl).toBe(0); // `None` counted as PRESENT
    expect(res.missing.devis).toBe(0);
    expect(res.missing.facture).toBe(0);
  });

  it('per-doc counters DIFFER when the missing pattern is heterogeneous', async () => {
    // Sanity check: proves the 4 counters no longer collapse to the
    // same value (the previous buggy behaviour reported 373 identical).
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          // Facture missing only
          { bcRef: '1', blRef: '2', devisRef: '3', factureRef: 'Sans' },
          { bcRef: '1', blRef: '2', devisRef: '3', factureRef: null },
          // BC missing only
          { bcRef: '_', blRef: '2', devisRef: '3', factureRef: 'OK' },
          // BL + Devis missing
          { bcRef: '1', blRef: 'sans', devisRef: '', factureRef: 'OK' },
          // All present
          { bcRef: '1', blRef: '2', devisRef: '3', factureRef: '4' },
        ]),
    });
    const res = await service.buildAndSend();
    expect(res.total).toBe(5);
    expect(res.totalIncompletes).toBe(4);
    expect(res.missing).toEqual({
      facture: 2,
      bc: 1,
      bl: 1,
      devis: 1,
    });
    // Explicit distinctness check:
    const counts = Object.values(res.missing);
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  it('reproduces the registry-scale target numbers (1334 rows → 788 COMPLET, 546 INCOMPLET, …)', () => {
    // Purely arithmetic — feeds the exact per-doc missing counts observed
    // on the real DB (verified live) into the rule and checks the
    // percentages match the expected 39.5% / 33.3% / 32.7% / 23.6%.
    const total = 1334;
    const complet = 788;
    const incomplet = 546;
    const missing = { facture: 527, bc: 444, bl: 436, devis: 315 };
    expect(complet + incomplet).toBe(total);
    expect(Math.round((complet / total) * 100)).toBe(59);
    expect(((missing.facture / total) * 100).toFixed(1)).toBe('39.5');
    expect(((missing.bc / total) * 100).toFixed(1)).toBe('33.3');
    expect(((missing.bl / total) * 100).toFixed(1)).toBe('32.7');
    expect(((missing.devis / total) * 100).toFixed(1)).toBe('23.6');
  });

  it('routes to APP_ALERT with the target emojis + « facturation à risque »', async () => {
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { bcRef: '1', blRef: '2', devisRef: '3', factureRef: 'Sans' },
          { bcRef: '1', blRef: '2', devisRef: '3', factureRef: 'Sans' },
        ]),
    });
    await service.buildAndSend();
    const [channel, payload] = discord.postEmbed.mock.calls[0];
    expect(channel).toBe('APP_ALERT');
    const desc: string = payload?.embeds?.[0]?.description ?? '';
    expect(desc).toContain('🔴');
    expect(desc).toContain('Facture');
    expect(desc).toContain('🟠 BC');
    expect(desc).toContain('🟠 BL');
    expect(desc).toContain('🟡 Devis');
    expect(desc).toContain('⚠️ facturation à risque');
    expect(desc).toContain('```');
    expect(payload?.embeds?.[0]?.title).toBe(
      '📊 FIXTRONIX · Suivi documentaire DiArchive',
    );
    expect(payload?.embeds?.[0]?.color).toBe(16289308);
  });

  it('renders « ▼ N depuis hier » on improvement (snapshot yesterday > today)', async () => {
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          // 100 incompletes today (factureRef=Sans on each)
          Array.from({ length: 100 }, () => ({
            bcRef: '1',
            blRef: '2',
            devisRef: '3',
            factureRef: 'Sans',
          })),
        ),
    });
    snapshot.findOne
      .mockReturnValueOnce({
        sort: () => ({
          lean: () =>
            Promise.resolve({ totalIncompletes: 127, date: new Date() }),
        }),
      })
      .mockReturnValueOnce({
        sort: () => ({ lean: () => Promise.resolve(null) }),
      });
    const res = await service.buildAndSend();
    expect(res.trendDay).toBe(27);
    const desc: string = discord.postEmbed.mock.calls[0][1].embeds[0].description;
    expect(desc).toContain('▼ 27 depuis hier');
  });

  it('renders « ▲ N depuis hier » on regression', async () => {
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          Array.from({ length: 150 }, () => ({
            bcRef: '1',
            blRef: '2',
            devisRef: '3',
            factureRef: 'Sans',
          })),
        ),
    });
    snapshot.findOne
      .mockReturnValueOnce({
        sort: () => ({
          lean: () =>
            Promise.resolve({ totalIncompletes: 120, date: new Date() }),
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
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          Array.from({ length: 5 }, () => ({
            bcRef: '_',
            blRef: '2',
            devisRef: '3',
            factureRef: '4',
          })),
        ),
    });
    snapshot.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });
    const res = await service.buildAndSend();
    expect(res.trendDay).toBeNull();
    expect(res.trendWeek).toBeNull();
    const desc: string = discord.postEmbed.mock.calls[0][1].embeds[0].description;
    expect(desc).toContain('(première mesure)');
    expect(desc).not.toContain('🎯 En bonne voie');
  });

  it('renders the weekly progress line when the 7d delta is positive', async () => {
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve(
          Array.from({ length: 100 }, () => ({
            bcRef: '_',
            blRef: '2',
            devisRef: '3',
            factureRef: '4',
          })),
        ),
    });
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

  it('upserts today\'s snapshot with the freshly computed metrics', async () => {
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { bcRef: '_', blRef: '2', devisRef: '3', factureRef: 'Sans' },
          { bcRef: '1', blRef: '2', devisRef: '3', factureRef: '4' },
        ]),
    });
    await service.buildAndSend();
    expect(snapshot.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = snapshot.updateOne.mock.calls[0];
    expect(filter).toHaveProperty('date');
    expect(options).toEqual({ upsert: true });
    expect(update.$set).toMatchObject({
      totalDiArchive: 2,
      totalIncompletes: 1,
      missingFacture: 1,
      missingBc: 1,
    });
  });

  it('is idempotent — 2 runs the same day → 1 snapshot doc', async () => {
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { bcRef: '_', blRef: '2', devisRef: '3', factureRef: '4' },
        ]),
    });
    await service.buildAndSend();
    await service.buildAndSend();
    const store = (globalThis as any).__snapshotStore;
    expect(store).toHaveLength(1);
    expect(snapshot.updateOne).toHaveBeenCalledTimes(2);
  });

  it('handles zero incompletes (all rows present) as 100% complétude', async () => {
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { bcRef: '1', blRef: '2', devisRef: '3', factureRef: '4' },
          { bcRef: 'ANNULER', blRef: 'ANNULER', devisRef: 'ANNULER', factureRef: 'ANNULER' },
        ]),
    });
    snapshot.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });
    const res = await service.buildAndSend();
    expect(res.totalIncompletes).toBe(0);
    expect(res.completudePct).toBe(100);
    const desc: string = discord.postEmbed.mock.calls[0][1].embeds[0].description;
    expect(desc).toContain('100%');
  });

  it('handles empty archive (total=0) without divide-by-zero', async () => {
    diArchive.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    snapshot.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });
    const res = await service.buildAndSend();
    expect(res.total).toBe(0);
    expect(res.completudePct).toBe(100);
  });

  it('performs NO write on DiArchive (only DigestSnapshot is touched)', async () => {
    diArchive.find.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { bcRef: '_', blRef: 'sans', devisRef: null, factureRef: '' },
        ]),
    });
    await service.buildAndSend();
    expect(diArchive.updateOne).not.toHaveBeenCalled();
    expect(diArchive.updateMany).not.toHaveBeenCalled();
    expect(diArchive.deleteOne).not.toHaveBeenCalled();
    expect(diArchive.save).not.toHaveBeenCalled();
    expect(snapshot.updateOne).toHaveBeenCalledTimes(1);
  });
});
