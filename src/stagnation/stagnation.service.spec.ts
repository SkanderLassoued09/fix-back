import { StagnationService } from './stagnation.service';
import { AlertType } from '../alerts/alert.enums';

/**
 * Détection de stagnation — SEUIL UNIQUE À 48H (remplace 24h/72h/7j).
 * On mocke le modèle Di (find → DIs stagnantes) et le service d'alerte.
 */
describe('StagnationService — seuil unique 48h', () => {
  function makeSvc(stagnantDis: any[]) {
    const diModel = {
      find: jest.fn().mockReturnValue({
        select: () => ({ lean: () => Promise.resolve(stagnantDis) }),
      }),
    } as any;
    const alertService = {
      createAlertIfMissing: jest.fn().mockResolvedValue({ created: true }),
      resolveOpenAlertsForDi: jest.fn().mockResolvedValue(2),
    } as any;
    const svc = new StagnationService(diModel, alertService);
    return { svc, diModel, alertService };
  }

  it('n’a QU’UN seul seuil, de type DI_STAGNANT_48H à 48h', () => {
    const T = (StagnationService as any).THRESHOLDS;
    expect(T).toHaveLength(1);
    expect(T[0].type).toBe(AlertType.DI_STAGNANT_48H);
    expect(T[0].lowerMs).toBe(48 * 60 * 60 * 1000);
    // Les anciens seuils ne sont plus générés.
    const types = T.map((t: any) => t.type);
    expect(types).not.toContain(AlertType.DI_STAGNANT_24H);
    expect(types).not.toContain(AlertType.DI_STAGNANT_72H);
    expect(types).not.toContain(AlertType.DI_STAGNANT_7D);
  });

  it('crée une alerte DI_STAGNANT_48H pour une DI stagnante ≥ 48h (une seule passe)', async () => {
    const { svc, diModel, alertService } = makeSvc([
      {
        _id: 'DI1',
        _idnum: 'D1',
        status: 'PENDING1',
        statusUpdatedAt: new Date(Date.now() - 60 * 60 * 60 * 1000), // 60h
      },
    ]);
    const res = await svc.detectStagnantDi();

    // Un seul seuil ⇒ une seule requête de scan.
    expect(diModel.find).toHaveBeenCalledTimes(1);
    expect(alertService.createAlertIfMissing).toHaveBeenCalledTimes(1);
    expect(alertService.createAlertIfMissing.mock.calls[0][0].type).toBe(
      AlertType.DI_STAGNANT_48H,
    );
    // Pas de ping Discord par DI (digest quotidien groupé).
    expect(alertService.createAlertIfMissing.mock.calls[0][1]).toEqual({
      silent: true,
    });
    expect(res.created.DI_STAGNANT_48H).toBe(1);
  });

  it('résout les anciennes alertes 24h/72h/7j encore ouvertes (aucune purge)', async () => {
    const { svc, alertService } = makeSvc([
      { _id: 'DI1', _idnum: 'D1', status: 'PENDING1', statusUpdatedAt: new Date(0) },
    ]);
    await svc.detectStagnantDi();
    expect(alertService.resolveOpenAlertsForDi).toHaveBeenCalledWith(
      'DI1',
      [
        AlertType.DI_STAGNANT_24H,
        AlertType.DI_STAGNANT_72H,
        AlertType.DI_STAGNANT_7D,
      ],
      null,
    );
  });

  it('ne crée rien quand aucune DI n’est stagnante', async () => {
    const { svc, alertService } = makeSvc([]);
    const res = await svc.detectStagnantDi();
    expect(alertService.createAlertIfMissing).not.toHaveBeenCalled();
    expect(res.created.DI_STAGNANT_48H).toBe(0);
  });
});
