import { DiscordHookService } from './discord-hook.service';

/**
 * Gate temporaire : Discord réduit à RETOUR (1/2/3) + STAGNATION. Tous les
 * autres types passent par `postEmbed`, qui est coupé quand
 * DISCORD_NOTIFS_DISABLED = true. Retour & stagnation appellent `deliverEmbed`
 * directement et restent donc émis.
 *
 * On espionne `deliverEmbed` (l'envoi bas-niveau réel) : s'il n'est pas appelé,
 * rien ne part vers Discord.
 */
describe('DiscordHookService — gate (retour + stagnation seulement)', () => {
  // Modèle Mongoose factice tolérant (findOne().lean() / .select().lean()).
  const model = {
    findOne: () => ({
      lean: () => Promise.resolve(null),
      select: () => ({ lean: () => Promise.resolve(null) }),
    }),
  } as any;

  function makeSvc() {
    const svc = new DiscordHookService(model, model, model);
    const deliver = jest
      .spyOn(svc as any, 'deliverEmbed')
      .mockResolvedValue(undefined);
    return { svc, deliver };
  }

  afterEach(() => jest.restoreAllMocks());

  it('COUPE les autres types : postEmbed ne délivre rien', async () => {
    const { svc, deliver } = makeSvc();
    await svc.postEmbed('GENERAL_ATELIER', { embeds: [] });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('COUPE un émetteur métier désactivé (ex. sendDiFinished)', async () => {
    const { svc, deliver } = makeSvc();
    await svc.sendDiFinished({ _idnum: 'DI1', title: 't', status: 'FINISHED' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('CONSERVE la stagnation (deliverEmbed appelé)', async () => {
    const { svc, deliver } = makeSvc();
    await svc.sendStagnationAlert({
      _id: 'a1',
      diId: 'DI1',
      type: 'DI_STAGNANT_48H',
      severity: 'WARNING',
      message: 'DI stagnante',
      // createdAt requis : sendStagnationAlert plante sinon (bug pré-existant
      // l.1078 — `.toISOString()` appelé sur un createdAt undefined).
      createdAt: new Date(),
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('APP_ALERT', expect.anything());
  });

  it('CONSERVE le retour (deliverEmbed appelé, niveaux 1/2/3)', async () => {
    for (const level of [1, 2, 3] as const) {
      const { svc, deliver } = makeSvc();
      await svc.sendDiRetour(
        { _idnum: 'DI1', title: 't', status: `RETOUR${level}` },
        level,
      );
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledWith('GENERAL_ATELIER', expect.anything());
    }
  });
});
