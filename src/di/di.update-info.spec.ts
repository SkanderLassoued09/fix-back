// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';

/**
 * `updateDiInfo` — modal « Modifier la DI » du tableau des interventions.
 *
 * Instance nue sur le prototype : seuls le modèle Mongo, l'upload Drive et le
 * journal sont simulés ; les gardes réelles (statut, client XOR société,
 * verrou de tarification) et l'écriture tracée partagée s'exécutent.
 */

const BASE_DI = {
  _id: 'DI_1',
  status: 'CREATED',
  title: 'Écran',
  description: 'Ne s’allume plus',
  nSerie: '',
  client_id: 'CL1',
  company_id: 'null', // chaîne littérale écrite par createDi
  location_id: 'L1',
  diagnosticPayant: true,
  diagnosticEstimate: 150,
  price: null,
  image: null,
  driveDocs: {},
};

const DRIVE_UPLOAD = {
  webViewLink: 'https://drive.google.com/file/d/NEWFILEID123/view',
  driveFileId: 'NEWFILEID123',
  fileName: 'ACME_Image.png',
};

const ACTOR = { id: 'U1', role: 'MANAGER' };

function makeSvc(di: any = BASE_DI) {
  const svc: any = Object.create(DiService.prototype);
  let stored = di ? { ...di } : null;
  svc.diModel = {
    findOne: jest.fn().mockImplementation(() => {
      const snapshot = stored ? { ...stored } : null;
      return {
        lean: jest.fn().mockResolvedValue(snapshot),
        select: jest.fn().mockResolvedValue(snapshot),
      };
    }),
    findOneAndUpdate: jest.fn().mockImplementation((_f: any, u: any) => {
      stored = { ...stored, ...u.$set };
      return Promise.resolve({ ...stored });
    }),
  };
  svc.syncEmplacementStatsForChange = jest.fn().mockResolvedValue(undefined);
  svc.notificationGateway = { updateTicket: jest.fn() };
  svc.notificationService = { emit: jest.fn().mockResolvedValue(undefined) };
  svc.captureDiscordFailure = jest.fn();
  svc.uploadDiDocToDrive = jest.fn().mockResolvedValue(DRIVE_UPLOAD);
  svc.captureUploadFailure = jest.fn().mockResolvedValue(undefined);
  return svc;
}

const writtenSet = (svc: any) =>
  svc.diModel.findOneAndUpdate.mock.calls[0]?.[1]?.$set;

describe('DiService.updateDiInfo — gardes', () => {
  it('DI introuvable → refus', async () => {
    const svc = makeSvc(null);
    await expect(
      svc.updateDiInfo({ _id: 'DI_X', title: 'T' }, ACTOR),
    ).rejects.toThrow(/introuvable/);
  });

  it('hors CREATED / PENDING1 → refus, aucune écriture', async () => {
    const svc = makeSvc({ ...BASE_DI, status: 'DIAGNOSTIC' });
    await expect(
      svc.updateDiInfo({ _id: 'DI_1', title: 'Autre' }, ACTOR),
    ).rejects.toThrow(/non modifiable/);
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('PENDING1 → accepté', async () => {
    const svc = makeSvc({ ...BASE_DI, status: 'PENDING1' });
    await svc.updateDiInfo({ _id: 'DI_1', title: 'Autre' }, ACTOR);
    expect(writtenSet(svc)).toEqual({ title: 'Autre' });
  });

  it('titre vidé → refus', async () => {
    const svc = makeSvc();
    await expect(
      svc.updateDiInfo({ _id: 'DI_1', title: '   ' }, ACTOR),
    ).rejects.toThrow(/obligatoires/);
  });

  it('verrou de tarification : « Diagnostic payant » non modifiable si prix posé', async () => {
    const svc = makeSvc({ ...BASE_DI, price: 200 });
    await expect(
      svc.updateDiInfo({ _id: 'DI_1', diagnosticPayant: false }, ACTOR),
    ).rejects.toThrow(/verrouillé/);
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('estimation négative → refus', async () => {
    const svc = makeSvc();
    await expect(
      svc.updateDiInfo({ _id: 'DI_1', diagnosticEstimate: -5 }, ACTOR),
    ).rejects.toThrow(/invalide/);
  });
});

describe('DiService.updateDiInfo — client OU société', () => {
  it('bascule client → société : client_id remis à null', async () => {
    const svc = makeSvc();
    await svc.updateDiInfo(
      { _id: 'DI_1', client_id: null, company_id: 'CO1' },
      ACTOR,
    );
    expect(writtenSet(svc)).toEqual({ client_id: null, company_id: 'CO1' });
  });

  it('aucune partie résolue (null / « null ») → refus', async () => {
    const svc = makeSvc();
    await expect(
      svc.updateDiInfo(
        { _id: 'DI_1', client_id: null, company_id: 'null' },
        ACTOR,
      ),
    ).rejects.toThrow(/client ou une société/);
  });

  it('société ajoutée sans retirer le client en base → refus', async () => {
    const svc = makeSvc();
    await expect(
      svc.updateDiInfo({ _id: 'DI_1', company_id: 'CO1' }, ACTOR),
    ).rejects.toThrow(/pas aux deux/);
  });
});

describe('DiService.updateDiInfo — diagnostic payant', () => {
  it('non payant → estimation effacée', async () => {
    const svc = makeSvc();
    await svc.updateDiInfo({ _id: 'DI_1', diagnosticPayant: false }, ACTOR);
    expect(writtenSet(svc)).toEqual({
      diagnosticPayant: false,
      diagnosticEstimate: null,
    });
  });
});

describe('DiService.updateDiInfo — photo', () => {
  const DATA_URL = 'data:image/png;base64,AAAA';

  it('data-URL → upload dans le dossier de la partie APRÈS édition', async () => {
    const svc = makeSvc();
    await svc.updateDiInfo(
      { _id: 'DI_1', client_id: null, company_id: 'CO1', image: DATA_URL },
      ACTOR,
    );
    expect(svc.uploadDiDocToDrive).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 'CO1', client_id: null }),
      DATA_URL,
      'Image',
    );
    expect(writtenSet(svc)).toEqual(
      expect.objectContaining({
        image: DRIVE_UPLOAD.webViewLink,
        'driveDocs.Image': {
          driveFileId: DRIVE_UPLOAD.driveFileId,
          webViewLink: DRIVE_UPLOAD.webViewLink,
          name: DRIVE_UPLOAD.fileName,
        },
      }),
    );
  });

  it('DI héritée sans objet driveDocs → objet complet (pas de chemin pointé)', async () => {
    const svc = makeSvc({ ...BASE_DI, driveDocs: null });
    await svc.updateDiInfo({ _id: 'DI_1', image: DATA_URL }, ACTOR);
    const set = writtenSet(svc);
    expect(set['driveDocs.Image']).toBeUndefined();
    expect(set.driveDocs).toEqual({
      Image: expect.objectContaining({ driveFileId: 'NEWFILEID123' }),
    });
  });

  it('sans data-URL → aucun upload, image non écrite', async () => {
    const svc = makeSvc();
    await svc.updateDiInfo({ _id: 'DI_1', title: 'Autre', image: '' }, ACTOR);
    expect(svc.uploadDiDocToDrive).not.toHaveBeenCalled();
    expect(writtenSet(svc)).toEqual({ title: 'Autre' });
  });

  it('échec d’upload → édition refusée, rien écrit, incident capturé', async () => {
    const svc = makeSvc();
    svc.uploadDiDocToDrive.mockRejectedValue(new Error('drive down'));
    await expect(
      svc.updateDiInfo({ _id: 'DI_1', title: 'Autre', image: DATA_URL }, ACTOR),
    ).rejects.toThrow('drive down');
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(svc.captureUploadFailure).toHaveBeenCalledWith(
      'UPDATE_DI_IMAGE',
      expect.any(Error),
      'DI_1',
    );
  });
});

describe('Écriture tracée partagée (DI_EDITED)', () => {
  it('updateDiInfo : le journal ne liste que les champs réellement changés', async () => {
    const svc = makeSvc();
    await svc.updateDiInfo(
      { _id: 'DI_1', title: 'Écran', nSerie: 'SN-42', image: 'data:image/png;base64,AAAA' },
      ACTOR,
    );
    const evt = svc.notificationService.emit.mock.calls[0][0];
    expect(evt.type).toBe('DI_EDITED');
    expect(evt.actorId).toBe('U1');
    expect(Object.keys(evt.payload.changes).sort()).toEqual(['image', 'nSerie']);
  });

  it('adminTechUpdateDi : écrit et journalise toujours (non-régression)', async () => {
    const svc = makeSvc({ ...BASE_DI, status: 'DIAGNOSTIC' });
    await svc.adminTechUpdateDi(
      { _id: 'DI_1', price: 300 },
      { id: 'A1', role: 'ADMIN_TECH' },
    );
    expect(writtenSet(svc)).toEqual({ price: 300 });
    expect(svc.notificationService.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DI_EDITED', actorId: 'A1' }),
    );
  });
});
