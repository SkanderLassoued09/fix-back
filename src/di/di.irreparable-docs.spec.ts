// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';

/**
 * DI IRRÉPARABLE — pièces jointes a posteriori, UNE fois par document.
 *
 * Toute DI irréparable accepte ses 4 documents (Devis, BC, BL, Facture) sans
 * quitter le statut IRREPARABLE. Chaque emplacement se remplit une seule fois :
 * un second dépôt est refusé AVANT l'upload Drive (`DOC_ALREADY_UPLOADED`).
 * Aucune notification « document suivant attendu » n'est émise : la DI est
 * terminale, elle n'attend rien.
 */

const REF = { driveFileId: 'abc', webViewLink: 'http://d/abc', name: 'f.pdf' };

const CASES = [
  { method: 'addDevisPDF', type: 'Devis', scalar: 'devis' },
  { method: 'addBCPDF', type: 'BC', scalar: 'bon_de_commande' },
  { method: 'addBlPDF', type: 'BL', scalar: 'bon_de_livraison' },
  { method: 'addFacturePDF', type: 'Facture', scalar: 'facture' },
] as const;

function makeSvc(di: any) {
  const svc: any = Object.create(DiService.prototype);
  const query = () => {
    const q: any = Promise.resolve(di);
    q.lean = () => Promise.resolve(di);
    q.select = () => query();
    return q;
  };
  svc.diModel = {
    findOne: jest.fn().mockImplementation(query),
    findOneAndUpdate: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
  svc.logsDiService = { upsertCycle: jest.fn().mockResolvedValue(null) };
  svc.statsService = { updateStatus: jest.fn().mockResolvedValue(undefined) };
  svc.discordHookService = {
    sendDiDevisUploaded: jest.fn().mockResolvedValue(undefined),
    sendDiBCUploaded: jest.fn().mockResolvedValue(undefined),
    sendDiBLUploaded: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = {
    updateTicket: jest.fn(),
    blAddedNotification: jest.fn(),
  };
  svc.notificationService = {
    clearByDiAndType: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn().mockResolvedValue(undefined),
  };
  svc.captureDiscordFailure = jest.fn();
  svc.captureUploadFailure = jest.fn();
  svc.uploadDiDocToDrive = jest.fn().mockResolvedValue({
    webViewLink: REF.webViewLink,
    driveFileId: REF.driveFileId,
    fileName: REF.name,
  });
  return svc;
}

describe('DI IRRÉPARABLE — un dépôt par document', () => {
  describe.each(CASES)('$type', ({ method, type, scalar }) => {
    it('emplacement vide : déposé, statut inchangé, aucun avis « document suivant »', async () => {
      const svc = makeSvc({
        _id: 'DI1',
        _idnum: 'T1',
        status: 'IRREPARABLE',
        ignoreCount: 0,
        // Le BC exige un devis (garde P3), qui n'est pas l'objet de ce test.
        ...(type === 'BC' ? { devis: 'http://d/devis' } : {}),
      });

      await svc[method]('DI1', 'base64');

      expect(svc.uploadDiDocToDrive).toHaveBeenCalledTimes(1);
      const [, , patch] = svc.logsDiService.upsertCycle.mock.calls[0];
      expect(patch[scalar]).toBe(REF.webViewLink);
      // Aucune transition : la porte documentaire ne touche pas IRREPARABLE.
      expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(svc.notificationService.emit).not.toHaveBeenCalled();
      expect(svc.notificationGateway.blAddedNotification).not.toHaveBeenCalled();
    });

    it('emplacement rempli (lien) : refusé AVANT Drive', async () => {
      const svc = makeSvc({
        _id: 'DI1',
        status: 'IRREPARABLE',
        devis: 'http://d/devis',
        [scalar]: 'http://d/deja-la',
      });

      await expect(svc[method]('DI1', 'base64')).rejects.toMatchObject({
        extensions: { code: 'DOC_ALREADY_UPLOADED' },
      });
      expect(svc.uploadDiDocToDrive).not.toHaveBeenCalled();
      expect(svc.logsDiService.upsertCycle).not.toHaveBeenCalled();
    });

    it('emplacement rempli (référence Drive seule) : refusé aussi', async () => {
      const svc = makeSvc({
        _id: 'DI1',
        status: 'IRREPARABLE',
        devis: 'http://d/devis',
        driveDocs: { [type]: REF },
      });

      await expect(svc[method]('DI1', 'base64')).rejects.toMatchObject({
        extensions: { code: 'DOC_ALREADY_UPLOADED' },
      });
      expect(svc.uploadDiDocToDrive).not.toHaveBeenCalled();
    });
  });

  it('hors IRREPARABLE : un document déjà présent ne bloque pas le dépôt (inchangé)', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      _idnum: 'T1',
      status: 'FINISHED',
      bon_de_livraison: 'http://d/deja-la',
    });

    await svc.addBlPDF('DI1', 'base64');

    expect(svc.uploadDiDocToDrive).toHaveBeenCalledTimes(1);
    // Le flux normal garde ses avis.
    expect(svc.notificationGateway.blAddedNotification).toHaveBeenCalled();
    expect(svc.notificationService.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DI_DOC_BL' }),
    );
  });
});
