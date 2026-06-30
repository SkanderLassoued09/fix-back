// DiService (imported transitively) pulls in nanoid, which is ESM-only and
// blows up under jest unless mocked — same guard as the other DI specs.
jest.mock('nanoid', () => ({ nanoid: () => 'rand' }));

import * as XLSX from 'xlsx';
import { DiImportService } from './di-import.service';

/**
 * Unit tests for the bulk DI import.
 *
 * Fixtures are real .xlsx buffers built in-test with SheetJS, with the header
 * deliberately on **row 4** (three blank rows above) to prove label-based
 * detection. All collaborators are mocked: nothing hits Mongo, Drive or Discord.
 *
 * Guards:
 *  - dry-run counts valid rows and persists NOTHING
 *  - import creates DIs with the EXACT file ref (forcedRef, generator bypassed)
 *  - existing ref → row error, never overwritten
 *  - intra-file duplicate ref → row error
 *  - same client across rows → a single auto-creation
 *  - missing mandatory column → global reject, 0 processed
 *  - ref in the auto-generation zone → non-blocking warning
 *  - numeric serial → string; DD/MM/YYYY parsed without TZ offset
 */

const HEADERS = ['N° DI', 'Désignation', 'N° Série', 'Client', 'Date de réception', 'Rangement'];

/** Build an .xlsx buffer with `headers` on Excel row `headerRow` (1-based). */
function buildXlsx(
  headers: any[],
  dataRows: any[][],
  headerRow = 4,
): Buffer {
  const aoa: any[][] = [];
  for (let i = 0; i < headerRow - 1; i++) aoa.push([]); // blank rows above
  aoa.push(headers);
  for (const r of dataRows) aoa.push(r);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'DI');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

type ModelMock = { find: jest.Mock };
const findReturning = (rows: any[]): ModelMock => ({
  find: jest.fn().mockReturnValue({ lean: () => Promise.resolve(rows) }),
});

interface Deps {
  diModel: ModelMock;
  clientModel: ModelMock;
  locationModel: ModelMock;
  diService: { createDi: jest.Mock };
  clientsService: { createClient: jest.Mock };
  locationService: { createlocation: jest.Mock };
}

function makeService(over: Partial<{ existingDi: any[]; clients: any[]; locations: any[] }> = {}) {
  let clientSeq = 0;
  let locSeq = 0;
  const deps: Deps = {
    diModel: findReturning(over.existingDi ?? []),
    clientModel: findReturning(over.clients ?? []),
    locationModel: findReturning(over.locations ?? []),
    diService: { createDi: jest.fn().mockResolvedValue({ _id: 'DI_rand' }) },
    clientsService: {
      createClient: jest
        .fn()
        .mockImplementation(async (i: any) => ({ _id: `C${++clientSeq}`, ...i })),
    },
    locationService: {
      createlocation: jest
        .fn()
        .mockImplementation(async (i: any) => ({ _id: `L${++locSeq}`, ...i })),
    },
  };
  const svc = new DiImportService(
    deps.diModel as any,
    deps.clientModel as any,
    deps.locationModel as any,
    deps.diService as any,
    deps.clientsService as any,
    deps.locationService as any,
  );
  return { svc, deps };
}

describe('DiImportService — dry-run', () => {
  it('detects the row-4 header, counts valid rows, and persists NOTHING', async () => {
    const { svc, deps } = makeService();
    const buf = buildXlsx(HEADERS, [
      ['T1394', 'AGRO NADHOUR', '***', 'COGEMHY', '18/06/2026', 'A28'],
      ['T1345', 'CARTE FOUR', '4821810100', 'PERSO (PROMODAR)', '04/05/2026', 'A15'],
    ]);
    const report = await svc.run(buf, { dryRun: true });

    expect(report.ligneEnTete).toBe(4);
    expect(report.total).toBe(2);
    expect(report.valides).toBe(2);
    expect(report.erreurs).toHaveLength(0);
    expect(report.crees).toBeUndefined();
    // Nothing persisted in dry-run.
    expect(deps.diService.createDi).not.toHaveBeenCalled();
    expect(deps.clientsService.createClient).not.toHaveBeenCalled();
  });

  it('flags missing required values per row with the real Excel line number', async () => {
    const { svc } = makeService();
    const buf = buildXlsx(HEADERS, [
      ['', 'NO REF', '***', 'ACME', '', ''], // line 5: missing N° DI
      ['T1', '', '***', 'ACME', '', ''], // line 6: missing Désignation
      ['T2', 'OK', '***', '', '', ''], // line 7: missing Client
    ]);
    const report = await svc.run(buf, { dryRun: true });
    expect(report.total).toBe(3);
    expect(report.valides).toBe(0);
    expect(report.erreurs.map((e) => e.ligne)).toEqual([5, 6, 7]);
  });
});

describe('DiImportService — import (dryRun=false)', () => {
  it('creates DIs with the EXACT file ref (forcedRef) + skipNotify, generator bypassed', async () => {
    const { svc, deps } = makeService({ existingDi: [{ _idnum: 'T1000' }] });
    const buf = buildXlsx(HEADERS, [
      ['T1394', 'AGRO NADHOUR', '***', 'COGEMHY', '18/06/2026', 'A28'],
    ]);
    const report = await svc.run(buf, { dryRun: false, createdBy: 'PROFILE_1' });

    expect(report.crees).toEqual({ dis: 1, clients: 1, locations: 1, ignorees: 0 });
    expect(deps.diService.createDi).toHaveBeenCalledTimes(1);
    const [input, opts] = deps.diService.createDi.mock.calls[0];
    expect(opts).toEqual({ forcedRef: 'T1394', skipNotify: true });
    expect(input).toEqual(
      expect.objectContaining({
        title: 'AGRO NADHOUR',
        nSerie: '***',
        type_client: 'Client',
        status: 'CREATED',
        createdBy: 'PROFILE_1',
      }),
    );
  });

  it('normalises a numeric serial to a string and parses DD/MM/YYYY without TZ offset', async () => {
    const { svc, deps } = makeService();
    const buf = buildXlsx(HEADERS, [
      // 4821810100 written as a real NUMBER cell; date as DD/MM/YYYY text.
      ['T1345', 'CARTE FOUR', 4821810100, 'PERSO', '04/05/2026', 'A15'],
    ]);
    await svc.run(buf, { dryRun: false });
    const [input] = deps.diService.createDi.mock.calls[0];
    expect(input.nSerie).toBe('4821810100');
    expect(input.dateReception).toBeInstanceOf(Date);
    expect(input.dateReception.toISOString().slice(0, 10)).toBe('2026-05-04');
  });

  it('auto-creates a client once when it recurs across rows; links Rangement → location', async () => {
    const { svc, deps } = makeService();
    const buf = buildXlsx(HEADERS, [
      ['T1', 'A', '***', 'COGEMHY', '', 'A28'],
      ['T2', 'B', '***', 'cogemhy', '', 'A28'], // same client (case-insensitive)
    ]);
    const report = await svc.run(buf, { dryRun: false });

    expect(report.crees).toEqual({ dis: 2, clients: 1, locations: 1, ignorees: 0 });
    expect(deps.clientsService.createClient).toHaveBeenCalledTimes(1);
    expect(deps.locationService.createlocation).toHaveBeenCalledTimes(1);
    // Both DIs point at the same auto-created client + location.
    const ids = deps.diService.createDi.mock.calls.map((c) => c[0].client_id);
    expect(ids[0]).toBe(ids[1]);
  });

  it('reuses an EXISTING client/location instead of creating duplicates', async () => {
    const { svc, deps } = makeService({
      clients: [{ _id: 'C9', first_name: 'COGEMHY', last_name: '' }],
      locations: [{ _id: 'L9', location_name: 'A28' }],
    });
    const buf = buildXlsx(HEADERS, [['T1', 'A', '***', 'COGEMHY', '', 'A28']]);
    const report = await svc.run(buf, { dryRun: false });

    expect(report.crees).toEqual({ dis: 1, clients: 0, locations: 0, ignorees: 0 });
    expect(deps.clientsService.createClient).not.toHaveBeenCalled();
    const [input] = deps.diService.createDi.mock.calls[0];
    expect(input.client_id).toBe('C9');
    expect(input.location_id).toBe('L9');
  });
});

describe('DiImportService — collisions & guards', () => {
  it('marks a row whose ref already exists in DB as an error and never persists it', async () => {
    const { svc, deps } = makeService({ existingDi: [{ _idnum: 'T1394' }] });
    const buf = buildXlsx(HEADERS, [
      ['T1394', 'DUP', '***', 'ACME', '', ''],
      ['T1395', 'OK', '***', 'ACME', '', ''],
    ]);
    const report = await svc.run(buf, { dryRun: false });

    expect(report.erreurs).toHaveLength(1);
    expect(report.erreurs[0].ligne).toBe(5);
    expect(report.erreurs[0].motifs[0]).toMatch(/déjà existant/i);
    expect(report.crees!.dis).toBe(1); // only T1395 imported
    const refs = deps.diService.createDi.mock.calls.map((c) => c[1].forcedRef);
    expect(refs).toEqual(['T1395']);
  });

  it('marks intra-file duplicate refs as errors (both rows)', async () => {
    const { svc, deps } = makeService();
    const buf = buildXlsx(HEADERS, [
      ['T5', 'A', '***', 'ACME', '', ''],
      ['T5', 'B', '***', 'ACME', '', ''],
    ]);
    const report = await svc.run(buf, { dryRun: false });

    expect(report.erreurs.map((e) => e.ligne).sort()).toEqual([5, 6]);
    expect(report.crees!.dis).toBe(0);
    expect(deps.diService.createDi).not.toHaveBeenCalled();
  });

  it('global-rejects a file whose header misses a mandatory column (0 processed)', async () => {
    const { svc, deps } = makeService();
    // No "Client" column.
    const buf = buildXlsx(['N° DI', 'Désignation', 'N° Série', 'Rangement'], [
      ['T1', 'A', '***', 'A28'],
    ]);
    const report = await svc.run(buf, { dryRun: false });

    expect(report.enTeteInvalide).toBe(true);
    expect(report.ligneEnTete).toBeNull();
    expect(report.total).toBe(0);
    expect(report.erreurs[0].motifs[0]).toMatch(/en-tête introuvable/i);
    expect(deps.diService.createDi).not.toHaveBeenCalled();
  });

  it('warns (non-blocking) when a ref lands in the auto-generation zone', async () => {
    const { svc } = makeService({ existingDi: [{ _idnum: 'T2000' }] }); // nextAuto = 2001
    const buf = buildXlsx(HEADERS, [
      ['T1394', 'BACKFILL', '***', 'ACME', '', ''], // 1394 < 2001 → safe, no warn
      ['T2050', 'FUTURE', '***', 'ACME', '', ''], // 2050 ≥ 2001 → warn
    ]);
    const report = await svc.run(buf, { dryRun: true });

    expect(report.valides).toBe(2); // warnings never block
    const warnLines = report.warnings.filter((w) => /auto-générée/i.test(w.message));
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0].ligne).toBe(6);
  });

  it('warns on an unexpected ref format but still imports the row', async () => {
    const { svc } = makeService();
    const buf = buildXlsx(HEADERS, [['ABC-9', 'WEIRD', '***', 'ACME', '', '']]);
    const report = await svc.run(buf, { dryRun: true });
    expect(report.valides).toBe(1);
    expect(report.warnings.some((w) => /inhabituel/i.test(w.message))).toBe(true);
  });
});
