import * as mongoose from 'mongoose';
import { DiArchiveService } from './di-archive.service';
import {
  DiArchiveDocType,
  DiArchiveOrigin,
  DiArchiveSchema,
  StatutCompletude,
} from './entities/di-archive.entity';
import { buildArchiveFilter } from './di-archive-filter.util';

/**
 * Uses a REAL Mongoose model built from `DiArchiveSchema` (so schema defaults
 * apply), with `save()` stubbed so no DB connection is needed.
 */
describe('DiArchiveService', () => {
  let model: mongoose.Model<any>;
  let service: DiArchiveService;
  let saveSpy: jest.SpyInstance;

  beforeAll(() => {
    model =
      (mongoose.models.DiArchiveSpec2 as mongoose.Model<any>) ||
      mongoose.model('DiArchiveSpec2', DiArchiveSchema);
  });

  beforeEach(() => {
    saveSpy = jest
      .spyOn(model.prototype as any, 'save')
      .mockImplementation(function (this: any) {
        return Promise.resolve(this);
      });
    // create/migration paths don't touch Drive → a bare stub suffices.
    service = new DiArchiveService(model as any, {} as any);
  });

  afterEach(() => saveSpy.mockRestore());

  describe('create (manual / public path)', () => {
    it('defaults statutCompletude=INCOMPLET, origin=MANUAL, empty documents, no historical status', async () => {
      const out: any = await service.create({
        title: 'AGRO NADHOUR',
        numSerie: '***',
        arrangement: 'A28',
      });
      expect(out.statutCompletude).toBe(StatutCompletude.INCOMPLET);
      expect(out.origin).toBe(DiArchiveOrigin.MANUAL);
      expect(out.statutHistorique).toBeNull();
      expect(out.importBatchId).toBeNull();
      expect(out.bc).toBeNull();
      // clientNom + societeNom are two distinct strings, default null.
      expect(out.clientNom).toBeNull();
      expect(out.societeNom).toBeNull();
      expect(String(out._id)).toMatch(/^DIA_/);
    });

    it('persists clientNom AND societeNom as two distinct strings', async () => {
      const out: any = await service.create({
        title: 'X',
        clientNom: 'PERSO (PROMODAR)',
        societeNom: 'COGEMHY SARL',
      });
      expect(out.clientNom).toBe('PERSO (PROMODAR)');
      expect(out.societeNom).toBe('COGEMHY SARL');
    });
  });

  describe('createFromMigration (migration path — never exposed to the API)', () => {
    it('writes the historical status DIRECTLY + stamps origin=MIGRATION + batchId + refOrigine, docs empty, statutCompletude INCOMPLET', async () => {
      const out: any = await service.createFromMigration(
        {
          title: 'AGRO NADHOUR',
          numSerie: '4821810100',
          arrangement: 'A28',
          clientNom: 'COGEMHY',
          refOrigine: 'T1394',
          statutHistorique: 'Livré',
        },
        { batchId: 'BATCH_1' },
      );
      // Historical status written directly as final state (distinct from completude).
      expect(out.statutHistorique).toBe('Livré');
      expect(out.statutCompletude).toBe(StatutCompletude.INCOMPLET);
      // Provenance / traceability.
      expect(out.origin).toBe(DiArchiveOrigin.MIGRATION);
      expect(out.importBatchId).toBe('BATCH_1');
      expect(out.refOrigine).toBe('T1394');
      expect(out.clientNom).toBe('COGEMHY');
      // Documents empty (the .xlsx brings no files).
      expect(out.bc).toBeNull();
      expect(out.bl).toBeNull();
      expect(out.devis).toBeNull();
      expect(out.facture).toBeNull();
    });

    it('derives COMPLET when the 4 document REFS are present in the file', async () => {
      const out: any = await service.createFromMigration(
        {
          title: 'X',
          bcRef: 'BC-18',
          blRef: 'BL-9',
          devisRef: '072/24',
          factureRef: 'F-2024-11',
          validClient: 'OK',
        },
        { batchId: 'B' },
      );
      expect(out.statutCompletude).toBe(StatutCompletude.COMPLET);
      expect(out.bcRef).toBe('BC-18');
      expect(out.validClient).toBe('OK');
    });

    it('stays INCOMPLET when at least one document ref is empty (to upload)', async () => {
      const out: any = await service.createFromMigration(
        { title: 'X', bcRef: 'BC-18', blRef: 'BL-9', devisRef: '072/24' }, // facture missing
        { batchId: 'B' },
      );
      expect(out.statutCompletude).toBe(StatutCompletude.INCOMPLET);
    });

    it('leaves statutHistorique null when the file had no Statut column', async () => {
      const out: any = await service.createFromMigration(
        { title: 'CARTE FOUR', refOrigine: 'T1345' },
        { batchId: 'BATCH_1' },
      );
      expect(out.statutHistorique).toBeNull();
      expect(out.statutCompletude).toBe(StatutCompletude.INCOMPLET);
      expect(out.origin).toBe(DiArchiveOrigin.MIGRATION);
    });
  });
});

/**
 * findPage — server-side pagination/sort/filter wiring. Uses a hand-rolled mock
 * model (no DB): asserts the SAME query drives both count + find, that the
 * filter is built via buildArchiveFilter, and that skip/limit/sort are applied.
 */
describe('DiArchiveService.findPage', () => {
  let chain: any;
  let mockModel: any;
  let service: DiArchiveService;

  beforeEach(() => {
    chain = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ _id: 'DIA_1' }]),
    };
    mockModel = {
      find: jest.fn().mockReturnValue(chain),
      countDocuments: jest.fn().mockResolvedValue(42),
    };
    service = new DiArchiveService(mockModel as any, {} as any);
  });

  it('drives count + find with the SAME built query and returns {rows,totalCount}', async () => {
    const filter = { missingDocs: [DiArchiveDocType.FACTURE] };
    const expected = buildArchiveFilter(filter);
    const res = await service.findPage(filter, { page: 1, limit: 12 });

    expect(mockModel.find).toHaveBeenCalledWith(expected);
    expect(mockModel.countDocuments).toHaveBeenCalledWith(expected);
    expect(res).toEqual({ rows: [{ _id: 'DIA_1' }], totalCount: 42 });
  });

  it('paginates: page 3, limit 12 → skip 24, limit 12', async () => {
    await service.findPage(undefined, { page: 3, limit: 12 });
    expect(chain.skip).toHaveBeenCalledWith(24);
    expect(chain.limit).toHaveBeenCalledWith(12);
  });

  it('defaults to createdAt DESC and honours a whitelisted sort', async () => {
    await service.findPage(undefined, {});
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });

    chain.sort.mockClear();
    await service.findPage(undefined, { sortField: 'title', sortOrder: 1 });
    expect(chain.sort).toHaveBeenCalledWith({ title: 1 });
  });

  it('rejects a non-whitelisted sortField (falls back to createdAt)', async () => {
    await service.findPage(undefined, { sortField: 'evil; drop' });
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it('clamps limit to a sane maximum (200)', async () => {
    await service.findPage(undefined, { page: 1, limit: 99999 });
    expect(chain.limit).toHaveBeenCalledWith(200);
  });
});
