import { DiArchiveService } from './di-archive.service';
import { DiArchiveDocType, StatutCompletude } from './entities/di-archive.entity';

/**
 * Document upload/removal + STRICT completude derivation.
 *  - the 4 docs present ⇒ COMPLET, else INCOMPLET (recomputed each mutation)
 *  - removing a doc from a COMPLET archive → INCOMPLET
 *  - CLOTURE is terminal: never overwritten by the derivation
 *  - the reused GoogleDriveService primitives store a real DriveDocRef
 *  - a Drive failure leaves the field + status untouched (no write)
 *
 * A tiny STATEFUL fake model tracks one doc across calls so the derivation is
 * exercised end-to-end; GoogleDriveService is fully mocked (no network).
 */

const PDF = 'data:application/pdf;base64,QUJD'; // "ABC"
const ref = () => ({ driveFileId: 'x', webViewLink: 'y', name: 'z' });

function makeHarness(initial: any = {}) {
  const doc: any = {
    _id: 'DIA_1',
    clientNom: 'COGEMHY',
    societeNom: null,
    bc: null,
    bl: null,
    devis: null,
    facture: null,
    statutCompletude: StatutCompletude.INCOMPLET,
    createdAt: new Date('2026-06-18T10:30:45.000Z'),
    ...initial,
  };

  const model = {
    findById: jest.fn(() => ({ lean: () => Promise.resolve({ ...doc }) })),
    findOneAndUpdate: jest.fn((_filter: any, update: any) => {
      Object.assign(doc, update.$set);
      return { lean: () => Promise.resolve({ ...doc }) };
    }),
    updateOne: jest.fn((filter: any, update: any) => {
      const ne = filter?.statutCompletude?.$ne;
      if (ne && doc.statutCompletude === ne) return Promise.resolve({ modifiedCount: 0 });
      Object.assign(doc, update.$set);
      return Promise.resolve({ modifiedCount: 1 });
    }),
  };

  const uploadFile = jest.fn((_folderId: string, fileName: string) =>
    Promise.resolve({ id: 'FILE_' + fileName, webViewLink: 'http://drive/' + fileName, name: fileName }),
  );
  const drive = {
    ensureEntityFolder: jest.fn().mockResolvedValue({ id: 'FOLDER_1', webViewLink: 'http://drive/folder' }),
    buildDocFileName: jest.fn((name: string, docType: string, ext: string) => `${name}_${docType}_stamp.${ext}`),
    uploadFile,
  };

  const service = new DiArchiveService(model as any, drive as any);
  return { service, model, drive, uploadFile, getDoc: () => doc };
}

describe('DiArchiveService — document upload & completude derivation', () => {
  it('uploads the 4 docs one by one → COMPLET only after the 4th', async () => {
    const h = makeHarness();
    let r: any = await h.service.uploadDoc('DIA_1', DiArchiveDocType.BC, PDF);
    expect(r.statutCompletude).toBe(StatutCompletude.INCOMPLET);
    r = await h.service.uploadDoc('DIA_1', DiArchiveDocType.BL, PDF);
    expect(r.statutCompletude).toBe(StatutCompletude.INCOMPLET);
    r = await h.service.uploadDoc('DIA_1', DiArchiveDocType.DEVIS, PDF);
    expect(r.statutCompletude).toBe(StatutCompletude.INCOMPLET);
    r = await h.service.uploadDoc('DIA_1', DiArchiveDocType.FACTURE, PDF);
    expect(r.statutCompletude).toBe(StatutCompletude.COMPLET);
  });

  it('stores the DriveDocRef (driveFileId/webViewLink/name) via the reused Drive fn, client folder from clientNom', async () => {
    const h = makeHarness();
    const r: any = await h.service.uploadDoc('DIA_1', DiArchiveDocType.BC, PDF);
    expect(r.bc).toEqual({
      driveFileId: expect.stringContaining('FILE_'),
      webViewLink: expect.stringContaining('http://drive/'),
      name: expect.stringContaining('_BC_'),
    });
    expect(h.drive.ensureEntityFolder).toHaveBeenCalledWith('client', 'COGEMHY', expect.any(Date));
    expect(h.drive.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('removing one doc from a COMPLET archive → back to INCOMPLET', async () => {
    const h = makeHarness({
      bc: ref(), bl: ref(), devis: ref(), facture: ref(),
      statutCompletude: StatutCompletude.COMPLET,
    });
    const r: any = await h.service.removeDoc('DIA_1', DiArchiveDocType.DEVIS);
    expect(r.devis).toBeNull();
    expect(r.statutCompletude).toBe(StatutCompletude.INCOMPLET);
  });

  it('upload on a CLOTURE archive stores the doc but NEVER flips statutCompletude', async () => {
    const h = makeHarness({
      bc: ref(), bl: ref(), devis: ref(),
      statutCompletude: StatutCompletude.CLOTURE,
    });
    const r: any = await h.service.uploadDoc('DIA_1', DiArchiveDocType.FACTURE, PDF);
    expect(r.facture).not.toBeNull(); // document still stored
    expect(r.statutCompletude).toBe(StatutCompletude.CLOTURE); // terminal — not overwritten
  });

  it('Drive upload failure → clean error, field + status untouched (no write)', async () => {
    const h = makeHarness({ bc: ref() });
    h.uploadFile.mockRejectedValueOnce(new Error('Drive 500'));
    await expect(h.service.uploadDoc('DIA_1', DiArchiveDocType.BL, PDF)).rejects.toThrow(/Drive 500/);
    expect(h.model.findOneAndUpdate).not.toHaveBeenCalled();
    expect(h.getDoc().bl).toBeNull();
    expect(h.getDoc().statutCompletude).toBe(StatutCompletude.INCOMPLET);
  });

  it('folder falls back to SANS_CLIENT when clientNom and societeNom are empty', async () => {
    const h = makeHarness({ clientNom: null, societeNom: null });
    await h.service.uploadDoc('DIA_1', DiArchiveDocType.BC, PDF);
    expect(h.drive.ensureEntityFolder).toHaveBeenCalledWith('client', 'SANS_CLIENT', expect.any(Date));
  });

  it('uses societeNom for the folder when clientNom is empty', async () => {
    const h = makeHarness({ clientNom: '', societeNom: 'COGEMHY SARL' });
    await h.service.uploadDoc('DIA_1', DiArchiveDocType.BC, PDF);
    expect(h.drive.ensureEntityFolder).toHaveBeenCalledWith('client', 'COGEMHY SARL', expect.any(Date));
  });
});
