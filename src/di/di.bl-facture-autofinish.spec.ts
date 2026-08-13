// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { STATUS_DI } from './di.status';

/**
 * DI status flow — SPLIT documentaire de la clôture :
 *   INREPARATION → WAITING_BL → (BL) → WAITING_FACTURE → (facture) → FINISHED.
 * L'avancement est AUTOMATIQUE (`maybeAdvanceDocGate`), atomique, idempotent,
 * cascade, et n'émet la notification « DI terminée » qu'au FINISHED réel.
 */

const REF = { driveFileId: 'abc', webViewLink: 'http://d/abc', name: 'f.pdf' };

/** `findOne().lean()` renvoie successivement les états passés (le helper relit la
 *  DI à chaque tour de cascade) ; le dernier état est répété ensuite. */
function makeGateSvc(states: any[], updateResults: any[] = []) {
  const svc: any = Object.create(DiService.prototype);
  const leanQueue = [...states];
  const findOne = jest.fn().mockImplementation(() => ({
    lean: () =>
      Promise.resolve(
        leanQueue.length > 1 ? leanQueue.shift() : leanQueue[0],
      ),
  }));
  const fau = jest.fn();
  updateResults.forEach((r) => fau.mockResolvedValueOnce(r));
  fau.mockResolvedValue(updateResults[updateResults.length - 1] ?? null);
  svc.diModel = { findOne, findOneAndUpdate: fau };
  svc.statsService = { updateStatus: jest.fn().mockResolvedValue(undefined) };
  svc.discordHookService = {
    sendDiFinished: jest.fn().mockResolvedValue(undefined),
    sendDiInMagasin: jest.fn().mockResolvedValue(undefined),
    sendDiStatusPending3: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = { updateTicket: jest.fn() };
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

describe('DiService.maybeAdvanceDocGate — chaîne de clôture', () => {
  it('WAITING_FACTURE + facture → FINISHED (une seule notif)', async () => {
    const svc = makeGateSvc(
      [
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingFacture.status,
          ignoreCount: 0,
          driveDocs: { BL: REF, Facture: REF },
        },
      ],
      [{ _id: 'DI1', status: STATUS_DI.Finished.status }],
    );
    await svc.maybeAdvanceDocGate('DI1');
    const [filter, update] = svc.diModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      _id: 'DI1',
      status: STATUS_DI.WaitingFacture.status,
    });
    expect(update.$set.status).toBe(STATUS_DI.Finished.status);
    expect(svc.discordHookService.sendDiFinished).toHaveBeenCalledTimes(1);
  });

  it('WAITING_BL + BL seul → WAITING_FACTURE, PAS de clôture', async () => {
    const svc = makeGateSvc(
      [
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingBl.status,
          ignoreCount: 0,
          driveDocs: { BL: REF },
        },
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingFacture.status,
          ignoreCount: 0,
          driveDocs: { BL: REF },
        },
      ],
      [{ _id: 'DI1', status: STATUS_DI.WaitingFacture.status }],
    );
    await svc.maybeAdvanceDocGate('DI1');
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(svc.diModel.findOneAndUpdate.mock.calls[0][1].$set.status).toBe(
      STATUS_DI.WaitingFacture.status,
    );
    expect(svc.discordHookService.sendDiFinished).not.toHaveBeenCalled();
  });

  it('CASCADE : WAITING_BL + BL + facture déjà là → WAITING_FACTURE puis FINISHED (UNE notif finale)', async () => {
    const svc = makeGateSvc(
      [
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingBl.status,
          ignoreCount: 0,
          driveDocs: { BL: REF, Facture: REF },
        },
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingFacture.status,
          ignoreCount: 0,
          driveDocs: { BL: REF, Facture: REF },
        },
      ],
      [
        { _id: 'DI1', status: STATUS_DI.WaitingFacture.status },
        { _id: 'DI1', status: STATUS_DI.Finished.status },
      ],
    );
    await svc.maybeAdvanceDocGate('DI1');
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    // Aucune notif sur l'état intermédiaire ; UNE seule au FINISHED réel.
    expect(svc.discordHookService.sendDiFinished).toHaveBeenCalledTimes(1);
  });

  it('legacy CLOSING + BL + facture → FINISHED (comportement historique conservé)', async () => {
    const svc = makeGateSvc(
      [
        {
          _id: 'DI1',
          status: 'CLOSING',
          ignoreCount: 0,
          driveDocs: { BL: REF, Facture: REF },
        },
      ],
      [{ _id: 'DI1', status: STATUS_DI.Finished.status }],
    );
    await svc.maybeAdvanceDocGate('DI1');
    const [filter] = svc.diModel.findOneAndUpdate.mock.calls[0];
    expect(filter.status).toEqual({ $in: ['CLOSING', 'ATTENTE_BL_FACTURE'] });
    expect(svc.discordHookService.sendDiFinished).toHaveBeenCalledTimes(1);
  });

  it('facture legacy = string (pas un DriveDocRef) → aucune avance', async () => {
    const svc = makeGateSvc([
      {
        _id: 'DI1',
        status: STATUS_DI.WaitingFacture.status,
        ignoreCount: 0,
        driveDocs: { BL: REF, Facture: 'old.pdf' },
      },
    ]);
    await svc.maybeAdvanceDocGate('DI1');
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('retour (ignoreCount > 0) → no-op (docs en logsdis)', async () => {
    const svc = makeGateSvc([
      {
        _id: 'DI1',
        status: STATUS_DI.WaitingFacture.status,
        ignoreCount: 2,
        driveDocs: { BL: REF, Facture: REF },
      },
    ]);
    await svc.maybeAdvanceDocGate('DI1');
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('concurrent : le perdant (findOneAndUpdate → null) ne re-notifie pas', async () => {
    const svc = makeGateSvc(
      [
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingFacture.status,
          ignoreCount: 0,
          driveDocs: { BL: REF, Facture: REF },
        },
      ],
      [null],
    );
    await svc.maybeAdvanceDocGate('DI1');
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(svc.discordHookService.sendDiFinished).not.toHaveBeenCalled();
    expect(svc.statsService.updateStatus).not.toHaveBeenCalled();
  });
});

describe('DiService.maybeAdvanceDocGate — sortie WAITING_BC (routage confirm)', () => {
  it('réparable SANS composants → PENDING3', async () => {
    const svc = makeGateSvc(
      [
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingBc.status,
          ignoreCount: 0,
          can_be_repaired: true,
          contain_pdr: false,
          array_composants: [],
          driveDocs: { Devis: REF, BC: REF },
        },
      ],
      [{ _id: 'DI1', status: STATUS_DI.Pending3.status, ignoreCount: 0 }],
    );
    await svc.maybeAdvanceDocGate('DI1');
    const [filter, update] = svc.diModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'DI1', status: STATUS_DI.WaitingBc.status });
    expect(update.$set.status).toBe(STATUS_DI.Pending3.status);
    expect(svc.discordHookService.sendDiStatusPending3).toHaveBeenCalledTimes(1);
  });

  it('réparable AVEC composants → PROCESSING (magasin), jamais PENDING3 direct', async () => {
    const svc = makeGateSvc(
      [
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingBc.status,
          ignoreCount: 0,
          can_be_repaired: true,
          contain_pdr: true,
          array_composants: [{ nameComposant: 'x', quantity: 1 }],
          driveDocs: { Devis: REF, BC: REF },
        },
      ],
      [{ _id: 'DI1', status: STATUS_DI.InMagasin.status, ignoreCount: 0 }],
    );
    await svc.maybeAdvanceDocGate('DI1');
    expect(svc.diModel.findOneAndUpdate.mock.calls[0][1].$set.status).toBe(
      STATUS_DI.InMagasin.status,
    );
    expect(svc.discordHookService.sendDiInMagasin).toHaveBeenCalledTimes(1);
    expect(svc.discordHookService.sendDiStatusPending3).not.toHaveBeenCalled();
  });

  it('WAITING_DEVIS + devis → WAITING_BC (simple avance, pas de routage)', async () => {
    const svc = makeGateSvc(
      [
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingDevis.status,
          ignoreCount: 0,
          driveDocs: { Devis: REF },
        },
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingBc.status,
          ignoreCount: 0,
          driveDocs: { Devis: REF },
        },
      ],
      [{ _id: 'DI1', status: STATUS_DI.WaitingBc.status }],
    );
    await svc.maybeAdvanceDocGate('DI1');
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(svc.diModel.findOneAndUpdate.mock.calls[0][1].$set.status).toBe(
      STATUS_DI.WaitingBc.status,
    );
  });
});

describe('DiService.changeStatusTofinsh — DI réparée → WAITING_BL', () => {
  function makeFinishSvc(di: any) {
    const svc: any = Object.create(DiService.prototype);
    svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
    svc.diModel = {
      findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(di) }),
      findOneAndUpdate: jest.fn().mockResolvedValue({
        ...di,
        status: STATUS_DI.WaitingBl.status,
      }),
    };
    svc.statsService = {
      updateStatus: jest.fn().mockResolvedValue(undefined),
      closeDiagLeg: jest.fn().mockResolvedValue(null),
    };
    svc.discordHookService = {
      sendDiFinished: jest.fn().mockResolvedValue(undefined),
    };
    svc.notificationGateway = { updateTicket: jest.fn() };
    svc.captureDiscordFailure = jest.fn();
    // maybeAdvanceDocGate a son propre describe — stub ici.
    svc.maybeAdvanceDocGate = jest.fn().mockResolvedValue(undefined);
    return svc;
  }

  it('INREPARATION fin → WAITING_BL (pas FINISHED), pas de « DI terminée » Discord', async () => {
    const svc = makeFinishSvc({
      _id: 'DI1',
      status: STATUS_DI.InReparation.status,
      ignoreCount: 0,
    });
    await svc.changeStatusTofinsh('DI1');
    const update = svc.diModel.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.status).toBe(STATUS_DI.WaitingBl.status);
    expect(svc.discordHookService.sendDiFinished).not.toHaveBeenCalled();
    expect(svc.maybeAdvanceDocGate).toHaveBeenCalledWith('DI1');
  });
});
