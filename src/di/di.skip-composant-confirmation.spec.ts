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
  svc.logsDiService = { isSentToCoordinator: jest.fn() };
  svc.statsService = { updateStatus: jest.fn().mockResolvedValue(undefined) };
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
    // Stat kept in lock-step (T281/T282 divergence guard).
    expect(svc.statsService.updateStatus).toHaveBeenCalledWith(
      'DI1',
      STATUS_DI.ConfirmationComposants.status,
    );
  });
});
