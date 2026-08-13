import { NotificationService } from './notification.service';

/**
 * Preuves v1 (au niveau service, déterministes) :
 *  - ciblage PAR UTILISATEUR : seuls les destinataires reçoivent des lignes ET
 *    le push socket (`emitToUser`) — l'acteur ne se notifie pas lui-même ;
 *  - compteur de non-lus = `count({userId, readAt:null})` INDEXÉ, jamais une liste ;
 *  - badge à 0 indépendamment des `di_alerts` (collections distinctes) ;
 *  - « acteur inconnu » honnête (actorId=null) ;
 *  - événement d'historique TOUJOURS écrit, notification SEULEMENT si actionnable ;
 *  - `markRead` scopé à l'utilisateur (isolation).
 */
function makeSvc() {
  const events: any[] = [];
  const eventModel = {
    create: jest.fn(async (d: any) => {
      const doc = { _id: 'E' + events.length, ...d, createdAt: new Date() };
      events.push(doc);
      return doc;
    }),
    find: jest.fn(),
  };
  const notificationModel = {
    insertMany: jest.fn(async (rows: any[]) =>
      rows.map((r, i) => ({ _id: 'N' + i, ...r, createdAt: new Date() })),
    ),
    countDocuments: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 4 }),
    find: jest.fn(),
  };
  const profileModel = {
    // rôle → membres (mock générique paramétrable par test)
    find: jest.fn(() => ({ lean: async () => [] })),
    findOne: jest.fn(() => ({ lean: async () => ({ notificationSound: true }) })),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const gateway = { emitToUser: jest.fn(), emitToRole: jest.fn() };
  const svc = new NotificationService(
    eventModel as any,
    notificationModel as any,
    profileModel as any,
    gateway as any,
  );
  return { svc, eventModel, notificationModel, profileModel, gateway };
}

describe('NotificationService.emit — ciblage & historique', () => {
  it('CIBLAGE par-user : seuls A et B reçoivent lignes + socket ; l’acteur exclu', async () => {
    const { svc, notificationModel, gateway } = makeSvc();
    await svc.emit({
      type: 'DI_ASSIGNED_DIAG',
      message: 'DI affectée',
      diId: 'DI1',
      actorId: 'ACTOR',
      notify: { userIds: ['A', 'B', 'ACTOR'] }, // ACTOR = soi-même
    });
    const rows = notificationModel.insertMany.mock.calls[0][0];
    expect(rows.map((r: any) => r.userId).sort()).toEqual(['A', 'B']);
    expect(gateway.emitToUser).toHaveBeenCalledTimes(2);
    expect(gateway.emitToUser).toHaveBeenCalledWith('A', expect.anything());
    expect(gateway.emitToUser).toHaveBeenCalledWith('B', expect.anything());
    // JAMAIS l'acteur, JAMAIS un tiers
    expect(gateway.emitToUser).not.toHaveBeenCalledWith('ACTOR', expect.anything());
    expect(gateway.emitToUser).not.toHaveBeenCalledWith('C', expect.anything());
  });

  it('CIBLAGE par-rôle : le rôle est étendu en userIds membres', async () => {
    const { svc, notificationModel, profileModel } = makeSvc();
    profileModel.find = jest.fn(() => ({
      lean: async () => [{ _id: 'T1' }, { _id: 'T2' }],
    }));
    await svc.emit({
      type: 'ALERT_X',
      message: 'stagnation',
      notify: { roles: ['TECH'] },
    });
    expect(profileModel.find).toHaveBeenCalledWith(
      { role: { $in: ['TECH'] } },
      { _id: 1 },
    );
    const rows = notificationModel.insertMany.mock.calls[0][0];
    expect(rows.map((r: any) => r.userId).sort()).toEqual(['T1', 'T2']);
  });

  it('HISTORIQUE seul : sans `notify`, un event est écrit mais AUCUNE notification', async () => {
    const { svc, eventModel, notificationModel, gateway } = makeSvc();
    await svc.emit({ type: 'DI_STATUS_CHANGED', message: 'transition' });
    expect(eventModel.create).toHaveBeenCalledTimes(1);
    expect(notificationModel.insertMany).not.toHaveBeenCalled();
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });

  it('rôle actionnable NON résolu (0 membre) → event seul, 0 notification (badge non gonflé)', async () => {
    const { svc, eventModel, notificationModel } = makeSvc();
    // profileModel.find renvoie [] (ex. vocabulaire de rôle alerte ≠ profils)
    await svc.emit({
      type: 'ALERT_DI_STAGNANT_7D',
      message: 'stagnation',
      notify: { roles: ['Coordinator'] }, // ne matche aucun profil (COORDIANTOR)
    });
    expect(eventModel.create).toHaveBeenCalledTimes(1); // historique OK
    expect(notificationModel.insertMany).not.toHaveBeenCalled(); // 0 cloche
  });

  it('« acteur inconnu » honnête : actorId=null persisté tel quel', async () => {
    const { svc, eventModel } = makeSvc();
    await svc.emit({ type: 'X', message: 'm', actorId: null });
    expect(eventModel.create.mock.calls[0][0].actorId).toBeNull();
  });
});

describe('NotificationService — non-lus & lecture', () => {
  it('unreadCount = count({userId, readAt:null}) INDEXÉ (jamais une liste)', async () => {
    const { svc, notificationModel } = makeSvc();
    notificationModel.countDocuments = jest.fn().mockResolvedValue(3);
    const n = await svc.unreadCount('U1');
    expect(n).toBe(3);
    expect(notificationModel.countDocuments).toHaveBeenCalledWith({
      userId: 'U1',
      readAt: null,
    });
    expect(notificationModel.find).not.toHaveBeenCalled(); // pas de chargement de liste
  });

  it('BADGE À 0 malgré les alertes : le compteur ne lit QUE `notifications`', async () => {
    const { svc, notificationModel } = makeSvc();
    // Collection notifications vierge (les 215 di_alerts vivent AILLEURS).
    notificationModel.countDocuments = jest.fn().mockResolvedValue(0);
    expect(await svc.unreadCount('U1')).toBe(0);
    // Le service n'a AUCUN modèle di_alerts : impossible de compter des alertes.
    expect((svc as any).alertModel).toBeUndefined();
  });

  it('markRead est SCOPÉ à l’utilisateur (un user ne marque que les siennes)', async () => {
    const { svc, notificationModel } = makeSvc();
    await svc.markRead('U1', 'N9');
    expect(notificationModel.updateOne).toHaveBeenCalledWith(
      { _id: 'N9', userId: 'U1', readAt: null },
      { $set: { readAt: expect.any(Date) } },
    );
  });
});
