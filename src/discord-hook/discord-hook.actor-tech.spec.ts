import { DiscordHookService } from './discord-hook.service';
import { runWithRequest } from 'src/common/request-context';

/**
 * Chaque embed DI affiche « 🙋 Action par » (acteur de la requête, ou surcharge
 * explicite) et « 👨‍🔧 Technicien » (ligne Stat du cycle, ou surcharge) — sans
 * doublon avec les anciens champs ajoutés à la main (« Créée par »,
 * « Technicien », « Affecté par »).
 */
const PROFILES: Record<string, any> = {
  pDiag: { _id: 'pDiag', username: 'ali', role: 'TECH' },
  pRep: { _id: 'pRep', username: 'sami', role: 'TECH' },
  pCreator: { _id: 'pCreator', username: 'houda', role: 'MAGASIN' },
};

const lean = (value: any) => ({ lean: () => Promise.resolve(value) });

function makeSvc(stat: any = null) {
  const profileModel = {
    findOne: jest.fn((q: any) => lean(PROFILES[q?._id] ?? null)),
  };
  const statModel = { findOne: jest.fn(() => lean(stat)) };
  const empty = { findOne: jest.fn(() => lean(null)) };
  const svc = new DiscordHookService(
    empty as any,
    empty as any,
    profileModel as any,
    statModel as any,
  );
  const deliver = jest
    .spyOn(svc as any, 'deliverEmbed')
    .mockResolvedValue(undefined);
  const fields = (): Array<{ name: string; value: string }> =>
    (deliver.mock.calls[0][1] as any).embeds[0].fields;
  const field = (name: string) => fields().find((f) => f.name === name)?.value;
  const count = (name: string) => fields().filter((f) => f.name === name).length;
  return { svc, statModel, field, fields, count };
}

const di = {
  _id: 'd1',
  _idnum: 'DI1',
  title: 't',
  status: 'INDIAGNOSTIC',
  ignoreCount: 0,
};
const coord = { _id: 'c1', username: 'hamdi', role: 'COORDIANTOR' };

describe('DiscordHookService — acteur + technicien sur les embeds DI', () => {
  afterEach(() => jest.restoreAllMocks());

  it('acteur de la requête → « hamdi · Coordinatrice » (jamais le rôle brut)', async () => {
    const { svc, field } = makeSvc();
    await runWithRequest({ user: coord }, () => svc.sendDiagnosticStarted(di));
    expect(field('🙋 Action par')).toBe('hamdi · Coordinatrice');
  });

  it('hors requête (cron / ACTION) → « ⚙️ Système »', async () => {
    const { svc, field } = makeSvc();
    await svc.sendDiInMagasin(di);
    expect(field('🙋 Action par')).toBe('⚙️ Système');
  });

  it('requête sans jeton → « Inconnu »', async () => {
    const { svc, field } = makeSvc();
    await runWithRequest({ headers: {} }, () => svc.sendDiInMagasin(di));
    expect(field('🙋 Action par')).toBe('Inconnu');
  });

  it('technicien lu sur la ligne Stat du cycle COURANT (diag + rép)', async () => {
    const { svc, field, statModel } = makeSvc({
      id_tech_diag: 'pDiag',
      id_tech_rep: 'pRep',
    });
    await svc.sendDiInReparation({ ...di, ignoreCount: 2 });
    expect(statModel.findOne).toHaveBeenCalledWith({ _idDi: 'd1', ignoreCount: 2 });
    expect(field('👨‍🔧 Technicien')).toBe('Diag : ali · Rép : sami');
  });

  it('même technicien en diag et en rép → « ali (diag + rép) »', async () => {
    const { svc, field } = makeSvc({ id_tech_diag: 'pDiag', id_tech_rep: 'pDiag' });
    await svc.sendDiFinished(di);
    expect(field('👨‍🔧 Technicien')).toBe('ali (diag + rép)');
  });

  it('pas de ligne Stat → « Non affecté »', async () => {
    const { svc, field } = makeSvc(null);
    await svc.sendDiStatusPending1(di);
    expect(field('👨‍🔧 Technicien')).toBe('Non affecté');
  });

  it('une lecture Stat qui échoue ne bloque jamais l\'envoi', async () => {
    const { svc, field, statModel } = makeSvc();
    statModel.findOne.mockImplementation(() => {
      throw new Error('mongo down');
    });
    await svc.sendDiPricing(di);
    expect(field('👨‍🔧 Technicien')).toBe('Non affecté');
  });

  it('sendDiRetour lit le technicien du cycle QUI REVIENT (niveau - 1)', async () => {
    const { svc, field, statModel } = makeSvc({ id_tech_diag: 'pDiag', id_tech_rep: 'pRep' });
    await runWithRequest({ user: coord }, () =>
      svc.sendDiRetour({ ...di, status: 'RETOUR2', ignoreCount: 2 }, 2),
    );
    expect(statModel.findOne).toHaveBeenCalledWith({ _idDi: 'd1', ignoreCount: 1 });
    expect(field('👨‍🔧 Technicien')).toBe('Diag : ali · Rép : sami');
    expect(field('🙋 Action par')).toBe('hamdi · Coordinatrice');
  });

  it('sendDiPendingNotification : acteur = créateur, plus de « Créée par »', async () => {
    const { svc, field, count } = makeSvc();
    await runWithRequest({ user: coord }, () =>
      svc.sendDiPendingNotification({ ...di, createdBy: 'pCreator' }),
    );
    expect(field('🙋 Action par')).toBe('houda · Magasin');
    expect(count('🧑‍💼 Créée par')).toBe(0);
  });

  it('sendDiagnosticAssigned : technicien passé en surcharge, UN seul champ Technicien', async () => {
    const { svc, field, count } = makeSvc(null);
    await runWithRequest({ user: coord }, () => svc.sendDiagnosticAssigned(di, 'pDiag'));
    expect(field('👨‍🔧 Technicien')).toBe('Diag : ali');
    expect(count('👨‍🔧 Technicien')).toBe(1);
  });

  it('sendReparationAssigned : surcharge rép fusionnée avec le diag du Stat, sans « Affecté par »', async () => {
    const { svc, field, count } = makeSvc({ id_tech_diag: 'pDiag' });
    await runWithRequest({ user: coord }, () =>
      svc.sendReparationAssigned({ di, technician: 'pRep', activeDiCount: 3 }),
    );
    expect(field('👨‍🔧 Technicien')).toBe('Diag : ali · Rép : sami');
    expect(field('🙋 Action par')).toBe('hamdi · Coordinatrice');
    expect(count('🧑‍💼 Affecté par')).toBe(0);
    expect(count('👨‍🔧 Technicien réparation')).toBe(0);
    expect(field('📋 DI actifs (tech)')).toBe('3');
  });

  it('sendDiAssignedToTech : un seul champ Technicien', async () => {
    const { svc, count } = makeSvc(null);
    await svc.sendDiAssignedToTech({ di, stat: {}, technician: 'pDiag' });
    expect(count('👨‍🔧 Technicien')).toBe(1);
  });
});
