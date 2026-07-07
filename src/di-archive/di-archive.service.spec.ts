import * as mongoose from 'mongoose';
import { DiArchiveService } from './di-archive.service';
import {
  DiArchiveOrigin,
  DiArchiveSchema,
  StatutCompletude,
} from './entities/di-archive.entity';

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
