// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';

/**
 * « Réparation réussie ? » / « Tests validés ? » (wizard réparation) : écrits
 * par `tech_finishReperation` sur la LIGNE DU CYCLE seule — c'est elle que lit
 * le détail DI. La vraie `writeCurrentCycle` s'exécute ; seuls les modèles sont
 * simulés.
 */
function makeSvc(ignoreCount = 0) {
  const svc: any = Object.create(DiService.prototype);
  svc.diModel = {
    findOne: jest.fn().mockResolvedValue({ _id: 'DI1', ignoreCount }),
    findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'DI1' }),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  svc.logsDiService = {
    tech_finishReperationLogs: jest.fn().mockResolvedValue({}),
    upsertCycle: jest.fn().mockResolvedValue({}),
  };
  svc.snapshotPartPrices = jest.fn().mockResolvedValue(undefined);
  return svc;
}

describe('DiService.tech_finishReperation — Réparation réussie / Tests validés', () => {
  it('écrit les deux réponses sur la ligne du cycle 0, sans miroir DI', async () => {
    const svc = makeSvc(0);

    await svc.tech_finishReperation('DI1', 'ok', {
      repairSuccess: true,
      testsValidated: false,
    });

    expect(svc.logsDiService.upsertCycle).toHaveBeenCalledWith('DI1', 0, {
      repair_success: true,
      tests_validated: false,
    });
    expect(svc.diModel.updateOne).not.toHaveBeenCalled();
  });

  it('écrit sur la ligne du retour courant', async () => {
    const svc = makeSvc(2);

    await svc.tech_finishReperation('DI1', 'ok', {
      repairSuccess: false,
      testsValidated: true,
    });

    expect(svc.logsDiService.upsertCycle).toHaveBeenCalledWith('DI1', 2, {
      repair_success: false,
      tests_validated: true,
    });
  });

  it("n'écrit rien sans réponse (pause réparation) — rien n'est effacé", async () => {
    const svc = makeSvc(0);

    await svc.tech_finishReperation('DI1', 'undefined');

    expect(svc.logsDiService.upsertCycle).not.toHaveBeenCalled();
  });

  it("n'écrit que les booléens : null / undefined ne remplacent pas une valeur", async () => {
    const svc = makeSvc(1);

    await svc.tech_finishReperation('DI1', 'ok', {
      repairSuccess: null,
      testsValidated: true,
    });

    expect(svc.logsDiService.upsertCycle).toHaveBeenCalledWith('DI1', 1, {
      tests_validated: true,
    });
  });
});
