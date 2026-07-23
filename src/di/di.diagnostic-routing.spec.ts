// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { STATUS_DI } from './di.status';

/**
 * PDR-based diagnostic exit routing:
 *   - NO PDR (contain_pdr false OR no components to order) → PENDING2 directly,
 *     skipping Magasin ("facturer le diagnostic"). Applies repairable or not.
 *   - HAS PDR (contain_pdr true + components) → MagasinEstimation, unchanged.
 * The transition guard already allows INDIAGNOSTIC → PENDING2, so no guard
 * change is needed — this only adds the automatic branch in one back method.
 */

function makeSvc(di: any) {
  const svc: any = Object.create(DiService.prototype);
  svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
  svc.diModel = {
    findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(di) }),
    findOneAndUpdate: jest.fn().mockResolvedValue({
      ...di,
      status: STATUS_DI.MagasinEstimation.status,
      ignoreCount: 0,
    }),
  };
  svc.diWorkflowService = {
    transition: jest
      .fn()
      .mockResolvedValue({ di: { ...di, status: STATUS_DI.Pending2.status } }),
  };
  svc.statsService = {
    updateStatus: jest.fn().mockResolvedValue(undefined),
    // Fermeture serveur du segment de travail diagnostic (no-op si fermé).
    closeDiagLeg: jest.fn().mockResolvedValue(null),
    openDiagLeg: jest.fn().mockResolvedValue(true),
  };
  svc.discordHookService = {
    sendDiagnosticFinished: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = { updateTicket: jest.fn() };
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

describe('DiService.changeStatusMagasinEstimation — PDR-based routing', () => {
  it('NO PDR (contain_pdr=false) → routes to PENDING2, skips Magasin', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      contain_pdr: false,
      array_composants: [],
    });

    await svc.changeStatusMagasinEstimation('DI1');

    // Went through the diagnostic-completed → PENDING2 transition…
    expect(svc.diWorkflowService.transition).toHaveBeenCalledWith(
      expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING2' }),
    );
    // …and did NOT write MagasinEstimation.
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('contain_pdr=true but NO components listed → still skips Magasin (nothing to order)', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      contain_pdr: true,
      array_composants: [],
    });

    await svc.changeStatusMagasinEstimation('DI1');

    expect(svc.diWorkflowService.transition).toHaveBeenCalledWith(
      expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING2' }),
    );
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('HAS PDR (contain_pdr=true + components) → MagasinEstimation, unchanged', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      contain_pdr: true,
      array_composants: [{ nameComposant: 'Fusible', quantity: 2 }],
    });

    await svc.changeStatusMagasinEstimation('DI1');

    // Normal Magasin path: writes MagasinEstimation, no PENDING2 transition.
    expect(svc.assertTransitionAllowed).toHaveBeenCalledWith(
      'DI1',
      STATUS_DI.MagasinEstimation.status,
    );
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalled();
  });
});

function makeFinishSvc(di: any) {
  const svc: any = Object.create(DiService.prototype);
  svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
  // Closure gate now runs before FINISHED — provide uploaded BL + Facture so
  // the finish path proceeds (the gate itself is covered by di.closure-gate.spec).
  const withFile = { driveFileId: 'f1', webViewLink: 'l', name: 'n' };
  svc.diModel = {
    findOne: jest.fn().mockReturnValue({
      lean: () => Promise.resolve(di),
      select: () => ({
        lean: () => Promise.resolve({ driveDocs: { BL: withFile, Facture: withFile } }),
      }),
    }),
    findOneAndUpdate: jest
      .fn()
      .mockResolvedValue({ ...di, status: STATUS_DI.Finished.status }),
  };
  svc.diWorkflowService = {
    transition: jest
      .fn()
      .mockResolvedValue({ di: { ...di, status: STATUS_DI.Pending2.status } }),
  };
  svc.statsService = {
    updateStatus: jest.fn().mockResolvedValue(undefined),
    // Fermeture serveur du segment de travail diagnostic (no-op si fermé).
    closeDiagLeg: jest.fn().mockResolvedValue(null),
    openDiagLeg: jest.fn().mockResolvedValue(true),
  };
  svc.discordHookService = {
    sendDiFinished: jest.fn().mockResolvedValue(undefined),
    sendDiagnosticFinished: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = { updateTicket: jest.fn() };
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

describe('DiService.changeStatusTofinsh — non-repairable routing', () => {
  it('ORIGINAL flow, non-repairable from diagnostic → PENDING2 (bill diagnostic), not FINISHED', async () => {
    const svc = makeFinishSvc({
      _id: 'DI1',
      status: STATUS_DI.InDiagnostic.status,
      ignoreCount: 0,
    });

    await svc.changeStatusTofinsh('DI1');

    expect(svc.diWorkflowService.transition).toHaveBeenCalledWith(
      expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING2' }),
    );
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled(); // never FINISHED
  });

  it('RETOUR cycle, non-repairable from diagnostic → FINISHED directly (unchanged)', async () => {
    const svc = makeFinishSvc({
      _id: 'DI1',
      status: STATUS_DI.InDiagnostic.status,
      ignoreCount: 1, // retour phase
    });

    await svc.changeStatusTofinsh('DI1');

    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledTimes(1); // → FINISHED
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalled();
    expect(svc.discordHookService.sendDiFinished).toHaveBeenCalledTimes(1);
  });

  it('a reparation-finish (status INREPARATION) is NOT redirected → FINISHED', async () => {
    const svc = makeFinishSvc({
      _id: 'DI1',
      status: STATUS_DI.InReparation.status,
      ignoreCount: 0,
    });

    await svc.changeStatusTofinsh('DI1');

    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledTimes(1); // → FINISHED
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalled();
  });
});
