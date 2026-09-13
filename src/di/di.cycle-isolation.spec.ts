// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { STATUS_DI } from './di.status';
import { MAGASIN_STATUS_DI_VALUES } from './di.status';

/**
 * SÉPARATION DES FLUX — chaque cycle possède ses propres données.
 *
 * Le bug d'origine, constaté en production : une DI diagnostiquée « réparable
 * AVEC PDR » au cycle 0, puis retournée et re-diagnostiquée « réparable SANS
 * PDR », affichait malgré tout la liste PDR et les fichiers du cycle 0 dans
 * l'onglet « Retour 1 ». Cause : le cycle retour écrivait dans LES MÊMES champs
 * de la DI que le cycle original, et rien n'était remis à zéro à l'entrée du
 * retour.
 *
 * Ces tests verrouillent les trois invariants du modèle par cycle :
 *   1. toute écriture métier va sur la ligne du cycle ET sur le miroir ;
 *   2. l'entrée en retour vide le miroir et fige le cycle sortant ;
 *   3. le niveau de retour est revendiqué ATOMIQUEMENT, plafonné à 3.
 */

const REF = { driveFileId: 'abc', webViewLink: 'http://d/abc', name: 'f.pdf' };

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
    findOneAndUpdate: jest
      .fn()
      .mockImplementation((filter: any, update: any) => {
        // Reproduit la garde atomique `{ ignoreCount: { $lt: 3 } }`.
        const lt = filter?.ignoreCount?.$lt;
        if (lt !== undefined && (di.ignoreCount ?? 0) >= lt) {
          return Promise.resolve(null);
        }
        if (update?.$inc?.ignoreCount) {
          di.ignoreCount = (di.ignoreCount ?? 0) + update.$inc.ignoreCount;
        }
        return Promise.resolve({ ...di, status: update?.$set?.status });
      }),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
  svc.logsDiService = {
    upsertCycle: jest.fn().mockResolvedValue(null),
    closeCycle: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(null),
    getLogsById: jest.fn().mockResolvedValue(null),
  };
  svc.statsService = {
    updateStatus: jest.fn().mockResolvedValue(undefined),
    closeDiagLeg: jest.fn().mockResolvedValue(null),
  };
  svc.discordHookService = {
    sendDiRetour: jest.fn().mockResolvedValue(undefined),
    sendDiDevisUploaded: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = { updateTicket: jest.fn() };
  svc.notificationService = {
    clearByDiAndType: jest.fn().mockResolvedValue(undefined),
  };
  svc.captureDiscordFailure = jest.fn();
  svc.captureUploadFailure = jest.fn();
  svc.emitRetourNotification = jest.fn().mockResolvedValue(undefined);
  svc.operationalErrorService = { capture: jest.fn().mockResolvedValue(null) };
  svc.uploadDiDocToDrive = jest.fn().mockResolvedValue({
    webViewLink: REF.webViewLink,
    driveFileId: REF.driveFileId,
    fileName: REF.name,
  });
  return svc;
}

describe('Séparation des flux — écriture par cycle', () => {
  it('un document déposé en RETOUR va sur la ligne du cycle, pas sur celle du cycle 0', async () => {
    const svc = makeSvc({ _id: 'DI1', _idnum: 'T1', ignoreCount: 2 });

    await svc.addDevisPDF('DI1', 'base64');

    const [diId, cycle, patch] = svc.logsDiService.upsertCycle.mock.calls[0];
    expect(diId).toBe('DI1');
    expect(cycle).toBe(2); // ← le cycle COURANT, jamais 0
    expect(patch.devis).toBe(REF.webViewLink);
    // `driveDocs` est écrit AUSSI sur la ligne de cycle : c'est son absence qui
    // faisait afficher éternellement le fichier (et le NOM) du cycle 0.
    expect(patch['driveDocs.Devis']).toEqual(REF);
  });

  it('le même dépôt en flux ORIGINAL vise le cycle 0', async () => {
    const svc = makeSvc({ _id: 'DI1', _idnum: 'T1', ignoreCount: 0 });

    await svc.addDevisPDF('DI1', 'base64');

    const [, cycle] = svc.logsDiService.upsertCycle.mock.calls[0];
    expect(cycle).toBe(0);
  });

  it('le miroir DI reçoit le même patch que la ligne de cycle', async () => {
    const svc = makeSvc({ _id: 'DI1', _idnum: 'T1', ignoreCount: 1 });

    await svc.addDevisPDF('DI1', 'base64');

    const [, , patch] = svc.logsDiService.upsertCycle.mock.calls[0];
    const [, mirror] = svc.diModel.updateOne.mock.calls[0];
    expect(mirror.$set).toEqual(patch);
  });
});

describe('Séparation des flux — entrée en retour', () => {
  it('vide le miroir : verdict, composants, documents, prix', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      _idnum: 'T1',
      ignoreCount: 0,
      can_be_repaired: true,
      contain_pdr: true,
      array_composants: [{ nameComposant: '47µF 50V', quantity: 2 }],
      devis: 'http://d/devis0',
      price: 850,
    });

    await svc.openRetourCycle('DI1', 'panne revenue');

    const call = svc.diModel.findOneAndUpdate.mock.calls.find(
      (c: any[]) => c[1]?.$set?.status === STATUS_DI.Retour1.status,
    );
    expect(call).toBeDefined();
    const { $set, $unset } = call[1];

    // C'est EXACTEMENT le symptôme signalé : un retour « sans PDR » ne doit
    // plus exposer la liste PDR du flux original.
    expect($set.array_composants).toEqual([]);
    expect($set.contain_pdr).toBe(false);
    expect($set.can_be_repaired).toBeNull();
    expect($set.devis).toBeNull();
    expect($set.facture).toBeNull();
    expect($set.price).toBeNull();
    expect($set.remarque_tech_diagnostic).toBeNull();
    // Ré-arme l'idempotence du décrément de stock pour le nouveau cycle.
    expect($set.stockDecrementedAt).toBeNull();

    // Les 4 documents sont retirés UN PAR UN : `driveDocs.Image` est la photo
    // de création, au niveau DI, et la vider casserait `GET /di/:id/image`.
    expect($unset).toEqual({
      'driveDocs.Devis': 1,
      'driveDocs.BC': 1,
      'driveDocs.BL': 1,
      'driveDocs.Facture': 1,
    });
    expect($unset['driveDocs.Image']).toBeUndefined();
  });

  it('reporte l’argent du miroir sur la ligne du cycle sortant AVANT de le vider', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      _idnum: 'T1',
      ignoreCount: 0,
      price: 250,
      final_price: 1200,
      repairEstimate: 900,
    });
    // Ligne du cycle 0 = squelette SANS montants (`$setOnInsert` sans argent) :
    // c'est exactement l'etat de toutes les DI en production.
    svc.logsDiService.getLogsById.mockResolvedValue({ _idDi: 'DI1', idIgnore: 0 });

    await svc.openRetourCycle('DI1', 'panne revenue');

    expect(svc.logsDiService.getLogsById).toHaveBeenCalledWith(0, 'DI1');
    const calls = svc.logsDiService.upsertCycle.mock.calls;
    const carryIdx = calls.findIndex((c: any[]) => c[1] === 0);
    expect(carryIdx).toBeGreaterThanOrEqual(0);
    expect(calls[carryIdx][2]).toEqual({
      price: 250,
      final_price: 1200,
      repairEstimate: 900,
    });

    // L'ORDRE compte : reporte PUIS vide — l'inverse efface la seule copie.
    const resetIdx = svc.diModel.findOneAndUpdate.mock.calls.findIndex(
      (c: any[]) => c[1]?.$set?.status === STATUS_DI.Retour1.status,
    );
    expect(
      svc.logsDiService.upsertCycle.mock.invocationCallOrder[carryIdx],
    ).toBeLessThan(
      svc.diModel.findOneAndUpdate.mock.invocationCallOrder[resetIdx],
    );
  });

  it('n’écrase jamais un montant déjà porté par la ligne (cycle retour)', async () => {
    // En retour, `savePricing` ecrit la LIGNE et le miroir vaut null ; seul
    // `repairEstimate` (ecrit sur la DI quel que soit le cycle) reste a reporter.
    const svc = makeSvc({
      _id: 'DI1',
      _idnum: 'T1',
      ignoreCount: 1,
      price: null,
      final_price: null,
      repairEstimate: 400,
    });
    svc.logsDiService.getLogsById.mockResolvedValue({
      _idDi: 'DI1',
      idIgnore: 1,
      price: 500,
      final_price: 950,
    });

    await svc.openRetourCycle('DI1', 'seconde panne');

    const carry = svc.logsDiService.upsertCycle.mock.calls.find(
      (c: any[]) => c[1] === 1,
    );
    expect(carry[2]).toEqual({ repairEstimate: 400 });
  });

  it('un diagnostic non payant (price 0) est reporté : 0 est un montant, pas une absence', async () => {
    const svc = makeSvc({ _id: 'DI1', _idnum: 'T1', ignoreCount: 0, price: 0 });

    await svc.openRetourCycle('DI1', 'motif');

    const carry = svc.logsDiService.upsertCycle.mock.calls.find(
      (c: any[]) => c[1] === 0,
    );
    expect(carry[2]).toEqual({ price: 0 });
  });

  it('rien à reporter → aucune écriture sur la ligne sortante', async () => {
    const svc = makeSvc({ _id: 'DI1', _idnum: 'T1', ignoreCount: 0 });

    await svc.openRetourCycle('DI1', 'motif');

    const carry = svc.logsDiService.upsertCycle.mock.calls.find(
      (c: any[]) => c[1] === 0,
    );
    expect(carry).toBeUndefined();
  });

  it('fige le cycle sortant et ouvre le nouveau avec SON motif', async () => {
    const svc = makeSvc({ _id: 'DI1', _idnum: 'T1', ignoreCount: 1 });

    const res = await svc.openRetourCycle('DI1', 'seconde panne');

    expect(res.level).toBe(2);
    expect(svc.logsDiService.closeCycle).toHaveBeenCalledWith(
      'DI1',
      1,
      expect.any(Date),
    );
    const [, cycle, patch] = svc.logsDiService.upsertCycle.mock.calls[0];
    expect(cycle).toBe(2);
    // Sur la DI, `retourReason` est écrasé à chaque retour : le motif du
    // retour 1 y était perdu dès le retour 2. Il vit désormais par cycle.
    expect(patch.retourReason).toBe('seconde panne');
    expect(patch.openedAt).toBeInstanceOf(Date);
  });

  it('revendique le niveau ATOMIQUEMENT (un seul $inc sous garde < 3)', async () => {
    const svc = makeSvc({ _id: 'DI1', _idnum: 'T1', ignoreCount: 0 });

    await svc.openRetourCycle('DI1', 'motif');

    const claim = svc.diModel.findOneAndUpdate.mock.calls[0];
    expect(claim[0]).toEqual({ _id: 'DI1', ignoreCount: { $lt: 3 } });
    expect(claim[1]).toEqual({ $inc: { ignoreCount: 1 } });
  });

  it('refuse un 4e retour sans rien écrire', async () => {
    const svc = makeSvc({ _id: 'DI1', _idnum: 'T1', ignoreCount: 3 });

    await expect(svc.openRetourCycle('DI1', 'motif')).rejects.toMatchObject({
      extensions: { code: 'RETOUR_LIMIT_REACHED' },
    });

    // Aucune transition de statut : le plafond est dans le FILTRE, pas dans un
    // `if` après coup — deux clics concurrents ne peuvent pas le franchir.
    const statusWrite = svc.diModel.findOneAndUpdate.mock.calls.find(
      (c: any[]) => c[1]?.$set?.status,
    );
    expect(statusWrite).toBeUndefined();
  });
});

describe('Séparation des flux — sûreté du vidage du miroir', () => {
  /**
   * Ce test encode la PREUVE qui autorise à vider `contain_pdr` sur le miroir.
   * L'ancien commentaire s'y refusait, craignant de « laisser le magasin en
   * attente indéfinie ». La liste magasin filtre `contain_pdr: true` ET
   * `status ∈ MAGASIN_STATUS_DI_VALUES` : une DI en RETOUR n'y est donc jamais.
   * Si quelqu'un ajoute un jour le rôle Magasin aux statuts RETOUR, ce test
   * casse — avant la liste magasin.
   */
  it('aucun statut RETOUR n’est visible du magasin', () => {
    expect(MAGASIN_STATUS_DI_VALUES).not.toContain(STATUS_DI.Retour1.status);
    expect(MAGASIN_STATUS_DI_VALUES).not.toContain(STATUS_DI.Retour2.status);
    expect(MAGASIN_STATUS_DI_VALUES).not.toContain(STATUS_DI.Retour3.status);
  });
});
