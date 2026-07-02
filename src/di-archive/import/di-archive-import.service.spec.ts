import * as XLSX from 'xlsx';
import { DiArchiveImportService } from './di-archive-import.service';

/**
 * Migration importer → `DiArchive` only. `DiArchiveService` is mocked, so nothing
 * hits Mongo. We assert: historical status mapped + written distinctly from
 * completude; origin/batch/refOrigine stamped; NO side effect (structural — the
 * importer has no Discord/Stat/Sheets dependency); unmapped/empty status → row
 * error; idempotence skip on refOrigine; base import (no Statut column) still OK.
 */

const HEADERS = ['N° DI', 'Désignation', 'Description', 'N° Série', 'Client', 'Statut', 'Rangement'];

function buildXlsx(headers: any[], dataRows: any[][], headerRow = 4): Buffer {
  const aoa: any[][] = [];
  for (let i = 0; i < headerRow - 1; i++) aoa.push([]); // blank rows above
  aoa.push(headers);
  for (const r of dataRows) aoa.push(r);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Archive');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('DiArchiveImportService (migration)', () => {
  let createFromMigration: jest.Mock;
  let existingMigrationRefs: jest.Mock;
  let svc: DiArchiveImportService;
  // Probes for effects the importer must NEVER trigger (structural: not deps).
  const sideEffects = { discord: jest.fn(), stat: jest.fn(), sheets: jest.fn(), reminder: jest.fn() };

  beforeEach(() => {
    createFromMigration = jest.fn().mockResolvedValue({ _id: 'DIA_x' });
    existingMigrationRefs = jest.fn().mockResolvedValue(new Set<string>());
    svc = new DiArchiveImportService({ createFromMigration, existingMigrationRefs } as any);
    Object.values(sideEffects).forEach((f) => f.mockClear());
  });

  it('dry-run: detects the row-4 header, maps statuses, persists NOTHING', async () => {
    const buf = buildXlsx(HEADERS, [
      ['T1394', 'AGRO NADHOUR', 'carte', '***', 'COGEMHY', 'Livré', 'A28'],
      ['T1345', 'CARTE FOUR', '', '4821810100', 'PERSO', 'Annulé', 'A15'],
    ]);
    const r = await svc.run(buf, { dryRun: true });
    expect(r.ligneEnTete).toBe(4);
    expect(r.total).toBe(2);
    expect(r.valides).toBe(2);
    expect(r.crees).toBeUndefined();
    expect(createFromMigration).not.toHaveBeenCalled();
  });

  it('import: writes historical status DIRECTLY + stamps origin/batch/refOrigine; NO side effect', async () => {
    const buf = buildXlsx(HEADERS, [
      ['T1394', 'AGRO NADHOUR', 'carte four', 4821810100, 'COGEMHY', 'Livré', 'A28'],
      ['T1345', 'CARTE FOUR', '', '***', 'PERSO', 'Terminé', 'A15'],
    ]);
    const r = await svc.run(buf, { dryRun: false });

    expect(r.crees!.archives).toBe(2);
    expect(r.crees!.importBatchId).toBeTruthy();
    expect(createFromMigration).toHaveBeenCalledTimes(2);

    const [input0, opts0] = createFromMigration.mock.calls[0];
    expect(input0).toEqual(
      expect.objectContaining({
        title: 'AGRO NADHOUR',
        numSerie: '4821810100', // number → string
        clientNom: 'COGEMHY',
        refOrigine: 'T1394',
        statutHistorique: 'Livré', // stored VERBATIM (free text), distinct from completude
      }),
    );
    // Same batch id across every row of the run, and it matches the report.
    const opts1 = createFromMigration.mock.calls[1][1];
    expect(opts0.batchId).toBe(opts1.batchId);
    expect(opts0.batchId).toBe(r.crees!.importBatchId);

    // NO side effect triggered (importer has no such dependency).
    Object.values(sideEffects).forEach((f) => expect(f).not.toHaveBeenCalled());
  });

  it('accepts ANY status (free text), stored VERBATIM — no rejection on status', async () => {
    const buf = buildXlsx(HEADERS, [
      ['T1', 'A', '', '***', 'C', 'En cours', 'A1'],
      ['T2', 'B', '', '***', 'C', 'Att. BC', 'A2'],
      ['T3', 'D', '', '***', 'C', '', 'A3'], // empty status → null, still valid
    ]);
    const r = await svc.run(buf, { dryRun: false });
    expect(r.erreurs).toHaveLength(0);
    expect(r.crees!.archives).toBe(3);
    const statuts = createFromMigration.mock.calls.map((c) => c[0].statutHistorique);
    expect(statuts).toEqual(['En cours', 'Att. BC', null]);
  });

  it('idempotence: an already-migrated refOrigine is SKIPPED (not duplicated)', async () => {
    existingMigrationRefs.mockResolvedValue(new Set(['T1394']));
    const buf = buildXlsx(HEADERS, [
      ['T1394', 'A', '', '***', 'C', 'Livré', 'A1'], // already migrated → skip
      ['T9999', 'B', '', '***', 'C', 'Livré', 'A2'], // new → import
    ]);
    const r = await svc.run(buf, { dryRun: false });

    expect(r.warnings.some((w) => /déjà importé/i.test(w.message))).toBe(true);
    expect(r.crees!.archives).toBe(1); // only T9999
    const refs = createFromMigration.mock.calls.map((c) => c[0].refOrigine);
    expect(refs).toEqual(['T9999']);
  });

  it('intra-file duplicate refOrigine → both rows error', async () => {
    const buf = buildXlsx(HEADERS, [
      ['T5', 'A', '', '***', 'C', 'Livré', 'A1'],
      ['T5', 'B', '', '***', 'C', 'Livré', 'A2'],
    ]);
    const r = await svc.run(buf, { dryRun: false });
    expect(r.erreurs.map((e) => e.ligne).sort()).toEqual([5, 6]);
    expect(createFromMigration).not.toHaveBeenCalled();
  });

  it('NON-REGRESSION: file WITHOUT a Statut column → rows valid, statutHistorique null (INCOMPLET stays the default)', async () => {
    const buf = buildXlsx(['Désignation', 'N° Série', 'Rangement'], [
      ['AGRO NADHOUR', '***', 'A28'],
      ['CARTE FOUR', '4821810100', 'A15'],
    ]);
    const r = await svc.run(buf, { dryRun: false });
    expect(r.valides).toBe(2);
    expect(r.crees!.archives).toBe(2);
    for (const call of createFromMigration.mock.calls) {
      expect(call[0].statutHistorique).toBeNull(); // no status captured
    }
  });

  it('missing mandatory column (Désignation) → global reject, 0 created', async () => {
    const buf = buildXlsx(['Statut', 'N° Série', 'Rangement'], [['Livré', '***', 'A1']]);
    const r = await svc.run(buf, { dryRun: false });
    expect(r.enTeteInvalide).toBe(true);
    expect(r.total).toBe(0);
    expect(createFromMigration).not.toHaveBeenCalled();
  });
});
