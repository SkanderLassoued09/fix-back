// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { GraphQLError } from 'graphql';
import { DiService } from './di.service';
import { STATUS_DI } from './di.status';

/**
 * Feature: skip the component-confirmation phase for DIs with NO components.
 *
 * The routing decision lives in the frontend (confirmerNegociation), but the
 * SERVER is authoritative: `changeStatusPending3` must REFUSE the skip
 * (NEGOTIATION → PENDING3) for a DI that has components — it must pass through
 * CONFIRMATION_COMPOSANTS. "Has components" = `contain_pdr === true` AND a
 * non-empty `array_composants` (both must agree).
 *
 * And `sendComponentToConMagasinForConfirmation` now materializes the phase as
 * a real status (INMAGASIN → CONFIRMATION_COMPOSANTS), not just flags.
 */

function makePending3Svc(di: any) {
  const svc: any = Object.create(DiService.prototype);
  svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
  svc.diModel = {
    findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(di) }),
    findOneAndUpdate: jest.fn().mockResolvedValue({
      ...di,
      status: STATUS_DI.Pending3.status,
      ignoreCount: di.ignoreCount ?? 0,
    }),
  };
  svc.statsService = { updateStatus: jest.fn().mockResolvedValue(undefined) };
  svc.discordHookService = {
    sendDiStatusPending3: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = { updateTicket: jest.fn() };
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

describe('DiService.changeStatusPending3 — component-confirmation guard', () => {
  it('REFUSES the skip NEGOTIATION1 → PENDING3 for a DI WITH components', async () => {
    const svc = makePending3Svc({
      _id: 'DI1',
      status: STATUS_DI.WaitingBc.status,
      contain_pdr: true,
      array_composants: [{ nameComposant: 'condo', quantity: 2 }],
    });
    await expect(svc.changeStatusPending3('DI1')).rejects.toBeInstanceOf(
      GraphQLError,
    );
    // The illegitimate skip never writes.
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('REFUSES the skip from NEGOTIATION2 too (mirror)', async () => {
    const svc = makePending3Svc({
      _id: 'DI1',
      status: STATUS_DI.Negotiation2.status,
      contain_pdr: true,
      array_composants: [{ nameComposant: 'x', quantity: 1 }],
    });
    await expect(svc.changeStatusPending3('DI1')).rejects.toMatchObject({
      extensions: { code: 'BAD_REQUEST' },
    });
  });

  it('ALLOWS the skip NEGOTIATION1 → PENDING3 when contain_pdr is false', async () => {
    const svc = makePending3Svc({
      _id: 'DI1',
      status: STATUS_DI.WaitingBc.status,
      contain_pdr: false,
      array_composants: [],
    });
    await expect(svc.changeStatusPending3('DI1')).resolves.toBeTruthy();
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalled();
  });

  it('ALLOWS the skip when contain_pdr is true but the component list is EMPTY (the toggle-lies gap)', async () => {
    const svc = makePending3Svc({
      _id: 'DI1',
      status: STATUS_DI.WaitingBc.status,
      contain_pdr: true,
      array_composants: [], // toggle on, but nothing to confirm → skip is legit
    });
    await expect(svc.changeStatusPending3('DI1')).resolves.toBeTruthy();
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalled();
  });

  it('ALLOWS the finalize CONFIRMATION_COMPOSANTS → PENDING3 even WITH components (post-confirmation)', async () => {
    const svc = makePending3Svc({
      _id: 'DI1',
      status: STATUS_DI.ConfirmationComposants.status,
      contain_pdr: true,
      array_composants: [{ nameComposant: 'condo', quantity: 2 }],
    });
    await expect(svc.changeStatusPending3('DI1')).resolves.toBeTruthy();
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalled();
  });

  it('ALLOWS the legacy finalize INMAGASIN → PENDING3 (in-flight DIs, cohabitation)', async () => {
    const svc = makePending3Svc({
      _id: 'DI1',
      status: STATUS_DI.InMagasin.status,
      contain_pdr: true,
      array_composants: [{ nameComposant: 'condo', quantity: 2 }],
    });
    await expect(svc.changeStatusPending3('DI1')).resolves.toBeTruthy();
  });
});

function makeSendSvc(di: any) {
  const svc: any = Object.create(DiService.prototype);
  svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
  svc.diModel = {
    findOne: jest.fn().mockResolvedValue(di),
    findOneAndUpdate: jest.fn().mockResolvedValue({
      ...di,
      status: STATUS_DI.ConfirmationComposants.status,
    }),
  };
  svc.logsDiService = { upsertCycle: jest.fn().mockResolvedValue({}) };
  svc.statsService = { updateStatus: jest.fn().mockResolvedValue(undefined) };
  svc.commitStockDecrementOnce = jest.fn().mockResolvedValue(undefined);
  svc.discordHookService = {
    sendComponentsSentToCoordinator: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = {
    sendComponentToCoordinatorFromMagasin: jest.fn(),
  };
  svc.buildPayload = jest.fn().mockReturnValue({});
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

describe('DiService.sendComponentToConMagasinForConfirmation — materializes the phase', () => {
  it('transitions INMAGASIN → CONFIRMATION_COMPOSANTS and syncs the Stat (original flow)', async () => {
    const svc = makeSendSvc({
      _id: 'DI1',
      status: STATUS_DI.InMagasin.status,
      ignoreCount: 0,
    });
    await svc.sendComponentToConMagasinForConfirmation('DI1');
    // Guarded against the new target status.
    expect(svc.assertTransitionAllowed).toHaveBeenCalledWith(
      'DI1',
      STATUS_DI.ConfirmationComposants.status,
    );
    const set = svc.diModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.status).toBe(STATUS_DI.ConfirmationComposants.status);
    expect(set.isSentToCoordinator).toBe(true);
    expect(set.handleSendingNotificationBetweenCoordinatorAndMagasin).toBe(
      'IN_MAGASIN',
    );
    // Stat kept in lock-step (T281/T282 divergence guard) — row of cycle 0.
    expect(svc.statsService.updateStatus).toHaveBeenCalledWith(
      'DI1',
      STATUS_DI.ConfirmationComposants.status,
      0,
    );
    expect(svc.commitStockDecrementOnce).toHaveBeenCalledWith('DI1');
  });

  it('RETOUR (ignoreCount 1) : même transition de STATUT que le flux original', async () => {
    const svc = makeSendSvc({
      _id: 'DI1',
      status: STATUS_DI.InMagasin.status,
      ignoreCount: 1,
    });
    await svc.sendComponentToConMagasinForConfirmation('DI1');
    expect(svc.assertTransitionAllowed).toHaveBeenCalledWith(
      'DI1',
      STATUS_DI.ConfirmationComposants.status,
    );
    // Le miroir DI change de statut (avant : seuls les drapeaux du log bougeaient
    // et la DI restait en CONFIRMATION → coordinatrice bloquée).
    const set = svc.diModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.status).toBe(STATUS_DI.ConfirmationComposants.status);
    // Dossier du cycle 1 : drapeaux de la poignée de main.
    expect(svc.logsDiService.upsertCycle).toHaveBeenCalledWith('DI1', 1, {
      isSentToCoordinator: true,
      handleSendingNotificationBetweenCoordinatorAndMagasin: 'IN_MAGASIN',
    });
    // Stat du cycle 1, pas celle du cycle 0.
    expect(svc.statsService.updateStatus).toHaveBeenCalledWith(
      'DI1',
      STATUS_DI.ConfirmationComposants.status,
      1,
    );
    expect(svc.commitStockDecrementOnce).toHaveBeenCalledWith('DI1');
  });
});

function makeConfirmSvc(di: any, flipped: any) {
  const svc: any = Object.create(DiService.prototype);
  svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
  svc.diModel = {
    findOne: jest.fn().mockResolvedValue(di),
    findOneAndUpdate: jest.fn().mockResolvedValue(flipped),
  };
  svc.logsDiService = { upsertCycle: jest.fn().mockResolvedValue({}) };
  svc.statsService = { updateStatus: jest.fn().mockResolvedValue(undefined) };
  svc.commitStockDecrementOnce = jest.fn().mockResolvedValue(undefined);
  svc.decrementStockForComposants = jest.fn().mockResolvedValue(1);
  svc.discordHookService = {
    sendComponentsConfirmedByCoordinator: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = { sendComponentToMagasinFromCoordinator: jest.fn() };
  svc.notificationService = { emit: jest.fn().mockResolvedValue(undefined) };
  svc.buildPayload = jest.fn().mockReturnValue({});
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

describe('DiService.componentConfirmedFromCoordinator — même statut en retour', () => {
  const RETOUR_DI = {
    _id: 'DI1',
    status: STATUS_DI.ConfirmationComposants.status,
    ignoreCount: 1,
    array_composants: [{ nameComposant: 'condo', quantity: 2 }],
  };

  it('RETOUR : ATTENTE_CONFIRMATION_COORDINATION → MAGASIN_FINALISATION + dossier du cycle', async () => {
    const svc = makeConfirmSvc(RETOUR_DI, {
      ...RETOUR_DI,
      status: STATUS_DI.MagasinFinalisation.status,
    });
    await svc.componentConfirmedFromCoordinator('DI1', 'COORD1');

    expect(svc.assertTransitionAllowed).toHaveBeenCalledWith(
      'DI1',
      STATUS_DI.MagasinFinalisation.status,
    );
    const [filter, update] = svc.diModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'DI1', componentsConfirmedAt: null });
    expect(update.$set.status).toBe(STATUS_DI.MagasinFinalisation.status);
    expect(update.$set.isConfirmedComponentFromCoordinator).toBe(true);
    expect(svc.logsDiService.upsertCycle).toHaveBeenCalledWith(
      'DI1',
      1,
      expect.objectContaining({
        isConfirmedComponentFromCoordinator: true,
        componentsConfirmedBy: 'COORD1',
      }),
    );
    expect(svc.statsService.updateStatus).toHaveBeenCalledWith(
      'DI1',
      STATUS_DI.MagasinFinalisation.status,
      1,
    );
  });

  it('RETOUR : un seul chemin de décrément (plus de décrément sur la ligne de log)', async () => {
    const svc = makeConfirmSvc(RETOUR_DI, {
      ...RETOUR_DI,
      status: STATUS_DI.MagasinFinalisation.status,
    });
    await svc.componentConfirmedFromCoordinator('DI1', 'COORD1');
    expect(svc.commitStockDecrementOnce).toHaveBeenCalledTimes(1);
    expect(svc.decrementStockForComposants).not.toHaveBeenCalled();
  });

  it('confirmation déjà faite (flip sans match) → aucune écriture de cycle ni décrément', async () => {
    const svc = makeConfirmSvc(
      { ...RETOUR_DI, status: STATUS_DI.MagasinFinalisation.status },
      null,
    );
    await svc.componentConfirmedFromCoordinator('DI1', 'COORD1');
    expect(svc.assertTransitionAllowed).not.toHaveBeenCalled();
    expect(svc.logsDiService.upsertCycle).not.toHaveBeenCalled();
    expect(svc.commitStockDecrementOnce).not.toHaveBeenCalled();
    expect(svc.statsService.updateStatus).not.toHaveBeenCalled();
  });
});
