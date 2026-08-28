// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { STATUS_DI } from './di.status';

/**
 * PDR-based diagnostic exit routing:
 *   - NO PDR (contain_pdr === false) → PENDING2 directly, skipping Magasin
 *     ("facturer le diagnostic"). Applies repairable or not.
 *   - HAS PDR (contain_pdr true + components) → MagasinEstimation, unchanged.
 *   - CONTRADICTION (contain_pdr === true mais AUCUN composant) → REFUS
 *     (BAD_REQUEST). Garde serveur miroir du blocage UI « Suivant » : ne route
 *     plus silencieusement vers PENDING2, et n'envoie jamais au Magasin une
 *     demande de pièces vide. Couvre les contournements du front (appel direct).
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
  // Notification ERP : le Magasin doit être prévenu quand la DI arrive en
  // estimation (diagnostic terminé AVEC PDR).
  svc.notificationService = { emit: jest.fn().mockResolvedValue({}) };
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
    // Pas de PDR → le Magasin n'a rien à estimer → aucune notif d'ESTIMATION
    // Magasin (la route PENDING2 émet DI_PENDING2 vers la coordination, c'est
    // normal ; ce qui compte : PAS de DI_MAGASIN_ESTIMATION ici).
    expect(svc.notificationService.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DI_MAGASIN_ESTIMATION' }),
    );
  });

  it('contain_pdr=true but NO components listed → REFUSED (contradiction, no routing)', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      contain_pdr: true,
      array_composants: [],
    });

    // Déclarer des PDR sans composant est contradictoire → refus explicite
    // (au lieu de l'ancien routage silencieux vers PENDING2).
    await expect(svc.changeStatusMagasinEstimation('DI1')).rejects.toThrow(
      /PDR déclaré sans composant/,
    );

    // Ni transition PENDING2 ni écriture Magasin : la soumission est rejetée.
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalled();
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
    // Bug 2 : le Magasin EST notifié à ce moment précis (1er contact avec la DI),
    // ciblé sur le rôle Magasin, type dédié (distinct de DI_IN_MAGASIN).
    expect(svc.notificationService.emit).toHaveBeenCalledTimes(1);
    expect(svc.notificationService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DI_MAGASIN_ESTIMATION',
        notify: { roles: ['Magasin'] },
      }),
    );
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
    sendDiIrreparable: jest.fn().mockResolvedValue(undefined),
    sendDiagnosticFinished: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = { updateTicket: jest.fn() };
  // Notif ERP de clôture : la clôture IRREPARABLE (via finalizeIrreparable)
  // émet DI_IRREPARABLE vers les rôles de suivi.
  svc.notificationService = { emit: jest.fn().mockResolvedValue({}) };
  svc.statsService.findUserLinkedToConcernedDi = jest
    .fn()
    .mockResolvedValue(null);
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

describe('DiService.changeStatusTofinsh — non-repairable routing', () => {
  it('ORIGINAL flow + PAYANT, non-repairable from diagnostic → PENDING2 (bill diagnostic), not closed', async () => {
    const svc = makeFinishSvc({
      _id: 'DI1',
      status: STATUS_DI.InDiagnostic.status,
      ignoreCount: 0,
      diagnosticPayant: true,
    });

    await svc.changeStatusTofinsh('DI1');

    expect(svc.diWorkflowService.transition).toHaveBeenCalledWith(
      expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING2' }),
    );
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled(); // never closed here
    expect(svc.discordHookService.sendDiIrreparable).not.toHaveBeenCalled();
  });

  it('ORIGINAL flow + NON PAYANT, non-repairable from diagnostic → IRREPARABLE directly (no billing)', async () => {
    const svc = makeFinishSvc({
      _id: 'DI1',
      status: STATUS_DI.InDiagnostic.status,
      ignoreCount: 0,
      diagnosticPayant: false, // non facturé → pas de PENDING2
    });

    await svc.changeStatusTofinsh('DI1');

    // Clôture directe IRREPARABLE : une écriture de statut, aucune facturation
    // (pas de transition PENDING2).
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalled();
    expect(svc.assertTransitionAllowed).toHaveBeenCalledWith(
      'DI1',
      STATUS_DI.Irreparable.status,
    );
    expect(svc.discordHookService.sendDiIrreparable).toHaveBeenCalledTimes(1);
    expect(svc.discordHookService.sendDiFinished).not.toHaveBeenCalled();
    // Sortie de diagnostic → fermeture du leg diagnostic (cumul serveur).
    expect(svc.statsService.closeDiagLeg).toHaveBeenCalledWith('DI1', 0);
    expect(svc.notificationService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DI_IRREPARABLE',
        notify: {
          roles: [
            'Manager',
            'Admin_Manager',
            'Admin_Tech',
            'Coordinator',
            'Magasin',
          ],
        },
      }),
    );
  });

  it('RETOUR cycle, non-repairable from diagnostic → IRREPARABLE directly (no billing in retour)', async () => {
    const svc = makeFinishSvc({
      _id: 'DI1',
      status: STATUS_DI.InDiagnostic.status,
      ignoreCount: 1, // retour phase
      diagnosticPayant: true, // même payant : en retour on ne re-facture pas
    });

    await svc.changeStatusTofinsh('DI1');

    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledTimes(1); // → IRREPARABLE
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalled();
    expect(svc.discordHookService.sendDiIrreparable).toHaveBeenCalledTimes(1);
    expect(svc.discordHookService.sendDiFinished).not.toHaveBeenCalled();
    // Clôture IRREPARABLE → DI_IRREPARABLE émis vers les rôles de suivi (sauf Tech).
    expect(svc.notificationService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DI_IRREPARABLE',
        notify: {
          roles: [
            'Manager',
            'Admin_Manager',
            'Admin_Tech',
            'Coordinator',
            'Magasin',
          ],
        },
      }),
    );
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
