import { StatService } from './stat.service';

/**
 * getStatByIdlogs — régression : une DI SANS pause logs (jamais mise en pause,
 * p.ex. pas un retour) ne doit PLUS lever « No logs found ». C'était la cause de
 * l'alerte opérationnelle INTERNAL_SERVER_ERROR sur les listes ticket/coordinateur.
 *
 * Test isolé sur le prototype (le TestModule complet du service échoue déjà sur
 * la résolution DI — non lié).
 */
describe('StatService.getStatByIdlogs — pas de crash sans logs', () => {
  function makeSvc(stat: any) {
    const svc: any = Object.create(StatService.prototype);
    svc.StatModel = { findOne: jest.fn().mockResolvedValue(stat) };
    svc.profileService = { getTech: jest.fn().mockResolvedValue('Tech Name') };
    svc.operationalErrorService = { capture: jest.fn().mockResolvedValue(undefined) };
    return svc;
  }

  it('retourne le stat (sans throw) quand pauseLogs est VIDE', async () => {
    const svc = makeSvc({ _idDi: 'DI1', pauseLogs: [] });
    const res = await svc.getStatByIdlogs('DI1');
    expect(res).toMatchObject({ _idDi: 'DI1', pauseLogs: [] });
    // Aucune alerte opérationnelle levée pour un état normal.
    expect(svc.operationalErrorService.capture).not.toHaveBeenCalled();
  });

  it('ne plante pas si pauseLogs est undefined', async () => {
    const svc = makeSvc({ _idDi: 'DI2' }); // pas de champ pauseLogs
    await expect(svc.getStatByIdlogs('DI2')).resolves.toMatchObject({
      _idDi: 'DI2',
    });
    expect(svc.operationalErrorService.capture).not.toHaveBeenCalled();
  });

  it('résout toujours les techs quand des logs existent (non-régression)', async () => {
    const svc = makeSvc({
      _idDi: 'DI3',
      pauseLogs: [{ at: new Date() }],
      id_tech_diag: 'T_DIAG',
      id_tech_rep: 'T_REP',
    });
    const res = await svc.getStatByIdlogs('DI3');
    expect(svc.profileService.getTech).toHaveBeenCalledWith('T_DIAG');
    expect(svc.profileService.getTech).toHaveBeenCalledWith('T_REP');
    expect(res.id_tech_diag).toBe('Tech Name');
  });

  it('lève toujours quand AUCUN stat n’existe (comportement inchangé)', async () => {
    const svc = makeSvc(null);
    await expect(svc.getStatByIdlogs('DI4')).rejects.toThrow('Stat not found');
    expect(svc.operationalErrorService.capture).toHaveBeenCalled();
  });
});
