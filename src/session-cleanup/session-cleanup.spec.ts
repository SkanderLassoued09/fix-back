// AppCronService tire `nanoid` (ESM only) — stub avant import, comme les
// autres specs du cron.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { SessionCleanupService } from './session-cleanup.service';
import { AppCronService } from '../cron/cron.service';

/**
 * Libération nocturne du verrou de session unique.
 *
 * Le cas décisif est le FILTRE : `{ isConnected: true }` et jamais `{}`.
 * Mongoose applique `timestamps` aux `updateMany`, donc un filtre vide
 * réécrirait `updatedAt` sur TOUS les profils chaque nuit — on détruirait le
 * seul indicateur d'ancienneté de session disponible (il n'existe pas de
 * `connectedAt`), et `modifiedCount` cesserait de vouloir dire quelque chose.
 */
function makeSvc(updateMany: jest.Mock) {
  const svc: any = Object.create(SessionCleanupService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.profileModel = { updateMany };
  return svc;
}

describe('SessionCleanupService', () => {
  it('ne cible QUE les profils marqués connectés (jamais toute la collection)', async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 4 });
    const svc = makeSvc(updateMany);

    await svc.run();

    const [filter, update] = updateMany.mock.calls[0];
    expect(filter).toEqual({ isConnected: true });
    expect(update).toEqual({ $set: { isConnected: false } });
    // Garde explicite contre la régression « filtre vide ».
    expect(Object.keys(filter)).toHaveLength(1);
  });

  it('remonte le nombre réel de comptes libérés', async () => {
    const svc = makeSvc(jest.fn().mockResolvedValue({ modifiedCount: 4 }));
    await expect(svc.run()).resolves.toEqual({ released: 4 });
  });

  it('une nuit sans session bloquée est un no-op à 0', async () => {
    const svc = makeSvc(jest.fn().mockResolvedValue({ modifiedCount: 0 }));
    await expect(svc.run()).resolves.toEqual({ released: 0 });
  });

  it('un pilote Mongo sans modifiedCount ne fait pas planter le cron', async () => {
    const svc = makeSvc(jest.fn().mockResolvedValue({}));
    await expect(svc.run()).resolves.toEqual({ released: 0 });
  });

  it('propage l’erreur DB (le déclencheur cron l’avale et la journalise)', async () => {
    const svc = makeSvc(jest.fn().mockRejectedValue(new Error('mongo down')));
    await expect(svc.run()).rejects.toThrow('mongo down');
  });
});

describe('AppCronService.triggerSessionCleanup', () => {
  function makeCron(run: jest.Mock) {
    const svc: any = Object.create(AppCronService.prototype);
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    svc.sessionCleanupService = { run };
    return svc;
  }

  it('journalise le compteur en cas de succès', async () => {
    const svc = makeCron(jest.fn().mockResolvedValue({ released: 3 }));
    await svc.triggerSessionCleanup();
    expect(svc.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('libérées=3'),
    );
    expect(svc.logger.error).not.toHaveBeenCalled();
  });

  it('AVALE une erreur DB — la boucle cron ne doit jamais mourir', async () => {
    const svc = makeCron(jest.fn().mockRejectedValue(new Error('mongo down')));
    await expect(svc.triggerSessionCleanup()).resolves.toBeUndefined();
    expect(svc.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Session cleanup failed'),
    );
  });
});
