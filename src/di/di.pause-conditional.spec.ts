// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { STATUS_DI } from './di.status';

/**
 * Pause/reprise : la pause est CONDITIONNELLE et ne bloque pas sur Discord.
 *
 * Une pause lente qui arrivait après une reprise (ou une sortie de diagnostic)
 * écrasait le statut suivant — l'écran et le serveur divergeaient et il fallait
 * cliquer deux fois. Et le webhook Discord, ATTENDU, retardait la réponse.
 */
function makeSvc(opts: { matched: any; current?: any; discord?: jest.Mock }) {
  const svc: any = Object.create(DiService.prototype);
  svc.diModel = {
    findOneAndUpdate: jest.fn().mockResolvedValue(opts.matched),
    findOne: jest.fn().mockResolvedValue(opts.current ?? null),
  };
  svc.statsService = {
    updateStatus: jest.fn().mockResolvedValue(undefined),
    closeDiagLeg: jest.fn().mockResolvedValue(undefined),
    closeRepLeg: jest.fn().mockResolvedValue(undefined),
  };
  const discord = opts.discord ?? jest.fn().mockResolvedValue(undefined);
  svc.discordHookService = {
    sendDiagnosticPaused: discord,
    sendReparationPaused: discord,
  };
  svc.captureDiscordFailure = jest.fn();
  svc.broadcastDiStatusChange = jest.fn().mockResolvedValue(undefined);
  return svc;
}

describe('DiService — pause conditionnelle', () => {
  it('diag : filtre sur le statut actif/pausé uniquement', async () => {
    const di = { _id: 'DI1', ignoreCount: 0, status: 'DIAGNOSTIC_Pause' };
    const svc = makeSvc({ matched: di });
    await svc.changeToDiagnosticInPause('DI1');

    const [filter] = svc.diModel.findOneAndUpdate.mock.calls[0];
    expect(filter.status.$in).toEqual([
      STATUS_DI.InDiagnostic.status,
      STATUS_DI.DiagnosticInPause.status,
    ]);
    expect(svc.statsService.closeDiagLeg).toHaveBeenCalledWith('DI1', 0);
  });

  it('diag : DI déjà sortie du diagnostic → aucune écriture, état réel renvoyé', async () => {
    const current = { _id: 'DI1', status: 'PENDING2' };
    const svc = makeSvc({ matched: null, current });
    const res = await svc.changeToDiagnosticInPause('DI1');

    expect(res).toBe(current);
    expect(svc.statsService.updateStatus).not.toHaveBeenCalled();
    expect(svc.statsService.closeDiagLeg).not.toHaveBeenCalled();
    expect(svc.broadcastDiStatusChange).not.toHaveBeenCalled();
  });

  it('diag : DI introuvable → erreur', async () => {
    const svc = makeSvc({ matched: null, current: null });
    await expect(svc.changeToDiagnosticInPause('NOPE')).rejects.toThrow();
  });

  it('réparation : filtre sur INREPARATION / REPARATION_Pause', async () => {
    const di = { _id: 'DI2', ignoreCount: 1, status: 'REPARATION_Pause' };
    const svc = makeSvc({ matched: di });
    await svc.changeStateInReparationPause('DI2');

    const [filter] = svc.diModel.findOneAndUpdate.mock.calls[0];
    expect(filter.status.$in).toEqual([
      STATUS_DI.InReparation.status,
      STATUS_DI.ReparationInPause.status,
    ]);
    expect(svc.statsService.closeRepLeg).toHaveBeenCalledWith('DI2', 1);
  });

  it('réparation : DI déjà sortie de la réparation → aucune écriture', async () => {
    const current = { _id: 'DI2', status: 'FINISHED' };
    const svc = makeSvc({ matched: null, current });
    expect(await svc.changeStateInReparationPause('DI2')).toBe(current);
    expect(svc.statsService.closeRepLeg).not.toHaveBeenCalled();
  });

  it('Discord NON attendu : un webhook bloqué ne retarde pas la pause', async () => {
    const never = jest.fn(() => new Promise(() => undefined));
    const di = { _id: 'DI1', ignoreCount: 0, status: 'DIAGNOSTIC_Pause' };
    const svc = makeSvc({ matched: di, discord: never as any });
    await expect(svc.changeToDiagnosticInPause('DI1')).resolves.toBe(di);
    expect(never).toHaveBeenCalled();
  });

  it('Discord en échec : capturé, la pause réussit', async () => {
    const boom = jest.fn().mockRejectedValue(new Error('discord down'));
    const di = { _id: 'DI1', ignoreCount: 0, status: 'DIAGNOSTIC_Pause' };
    const svc = makeSvc({ matched: di, discord: boom });
    await expect(svc.changeToDiagnosticInPause('DI1')).resolves.toBe(di);
    await new Promise((r) => setImmediate(r));
    expect(svc.captureDiscordFailure).toHaveBeenCalled();
  });
});

/**
 * Démarrage/réouverture : l'ancre du segment est posée SI AUCUNE n'existe, même
 * quand la DI est DÉJÀ en cours (données héritées sans ancre → chrono à l'arrêt).
 * Idempotent au niveau DB : une ancre existante n'est jamais déplacée.
 */
describe('DiService — ancre posée à la (ré)ouverture', () => {
  function makeStartSvc(previousStatus: string, status: string) {
    const svc: any = Object.create(DiService.prototype);
    const di = { _id: 'DI1', ignoreCount: 2, status };
    svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
    svc.diWorkflowService = {
      transition: jest.fn().mockResolvedValue({ di, previousStatus }),
    };
    svc.discordHookService = {
      sendDiagnosticResumed: jest.fn().mockResolvedValue(undefined),
      sendDiagnosticStarted: jest.fn().mockResolvedValue(undefined),
      sendReparationResumed: jest.fn().mockResolvedValue(undefined),
      sendReparationStarted: jest.fn().mockResolvedValue(undefined),
    };
    svc.captureDiscordFailure = jest.fn();
    svc.statsService = { openDiagLeg: jest.fn().mockResolvedValue(true) };
    svc.statModel = { updateOne: jest.fn().mockResolvedValue({}) };
    svc.notificationGateway = { updateTicket: jest.fn() };
    svc.broadcastDiStatusChange = jest.fn().mockResolvedValue(undefined);
    return svc;
  }

  it('diag déjà INDIAGNOSTIC (réouverture) : openDiagLeg appelé (idempotent)', async () => {
    const svc = makeStartSvc('INDIAGNOSTIC', 'INDIAGNOSTIC');
    await svc.changeStatusInDiagnostic('DI1');
    expect(svc.statsService.openDiagLeg).toHaveBeenCalledWith('DI1', 2);
  });

  it('diag premier démarrage (DIAGNOSTIC) : openDiagLeg appelé', async () => {
    const svc = makeStartSvc('DIAGNOSTIC', 'INDIAGNOSTIC');
    await svc.changeStatusInDiagnostic('DI1');
    expect(svc.statsService.openDiagLeg).toHaveBeenCalledWith('DI1', 2);
  });

  it('réparation déjà INREPARATION : ancre posée SEULEMENT si absente, cycle filtré', async () => {
    const svc = makeStartSvc('INREPARATION', 'INREPARATION');
    await svc.changeStatusInRepair('DI1');
    const [filter, update] = svc.statModel.updateOne.mock.calls[0];
    expect(filter).toEqual({ _idDi: 'DI1', ignoreCount: 2, repRunStartedAt: null });
    expect(update.$set.repRunStartedAt).toBeInstanceOf(Date);
  });
});
