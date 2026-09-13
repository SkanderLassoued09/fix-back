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
  // `broadcastDiStatusChange` (diffusion temps réel des sauts intermédiaires)
  // enrichit le payload avec les ids technicien lus sur le Stat.
  svc.statModel = {
    findOne: jest.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(null) }),
    }),
  };
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

/** Dernier `updateTicket` diffusé — les listes du front n'utilisent que
 *  `content.states` (cf. notification.service.ts, case 'updateTicket'). */
function lastBroadcast(svc: any) {
  const calls = svc.notificationGateway.updateTicket.mock.calls;
  return calls[calls.length - 1]?.[0];
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
    // TEMPS RÉEL — jumeau du saut devis → BC : ce palier intermédiaire doit lui
    // aussi réveiller les listes, sans quoi la DI reste « attente BL » à l'écran.
    expect(svc.notificationGateway.updateTicket).toHaveBeenCalledTimes(1);
    expect(lastBroadcast(svc).content.states.status).toBe(
      STATUS_DI.WaitingFacture.status,
    );
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
    // La diffusion socket, elle, suit CHAQUE saut (palier + FINISHED). Les deux
    // arrivent à quelques ms d'intervalle et le front les écrase via le
    // debounce de TicketRefreshService → un seul rechargement de liste.
    expect(svc.notificationGateway.updateTicket).toHaveBeenCalledTimes(2);
    expect(lastBroadcast(svc).content.states).toMatchObject({
      status: STATUS_DI.Finished.status,
    });
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

  // CONTRAT INVERSE depuis la separation par cycle. Avant, la porte sortait
  // immediatement quand `ignoreCount > 0` (« les docs d'un retour vivent en
  // logsdis ») : une DI de retour restait bloquee en WAITING_FACTURE meme BL
  // ET facture deposes, alors que l'UI proposait l'upload. Le miroir portant
  // desormais les documents du CYCLE COURANT, un retour franchit ses propres
  // portes — et le Stat mis a jour est celui de SON cycle, jamais celui du 0.
  it('retour (ignoreCount > 0) → la porte avance sur les docs DU CYCLE', async () => {
    const svc = makeGateSvc(
      [
        {
          _id: 'DI1',
          status: STATUS_DI.WaitingFacture.status,
          ignoreCount: 2,
          driveDocs: { BL: REF, Facture: REF },
        },
      ],
      [{ _id: 'DI1', status: STATUS_DI.Finished.status, ignoreCount: 2 }],
    );
    await svc.maybeAdvanceDocGate('DI1');

    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalled();
    const [, update] = svc.diModel.findOneAndUpdate.mock.calls[0];
    expect(update.$set.status).toBe(STATUS_DI.Finished.status);

    // Le cycle est passe a `updateStatus` : sans cela le statut du retour
    // serait ecrit sur la ligne Stat du cycle 0 (temps facturable corrompu).
    const call = svc.statsService.updateStatus.mock.calls.find(
      (c: any[]) => c[1] === STATUS_DI.Finished.status,
    );
    expect(call).toBeDefined();
    expect(call[2]).toBe(2);
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
    // TEMPS RÉEL — sans cette diffusion la DI passait en WAITING_BC en base et
    // restait affichée « attente devis » sur tous les écrans jusqu'au F5.
    expect(svc.notificationGateway.updateTicket).toHaveBeenCalledTimes(1);
    const sent = lastBroadcast(svc);
    expect(sent.action).toBe('updateState');
    expect(sent.content.states.status).toBe(STATUS_DI.WaitingBc.status);
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
      closeRepLeg: jest.fn().mockResolvedValue(null),
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
