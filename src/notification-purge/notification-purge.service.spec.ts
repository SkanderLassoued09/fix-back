import { NotificationPurgeService } from './notification-purge.service';

/**
 * Purge des notifications — 3 jours, sauf relance BL non satisfaite.
 *
 * Ce que ces tests verrouillent :
 *  - le filtre porte TOUJOURS sur `createdAt` (jamais `{}`) ;
 *  - une relance BL survit tant que le document manque, quel que soit son âge ;
 *  - elle est purgée dès que le BL est là — y compris pour une DI de RETOUR,
 *    dont le BL vit dans `logsdis` et non sur la DI (sinon : conservation
 *    perpétuelle) ;
 *  - un `diId` orphelin n'est pas exempté.
 */

const OLD = new Date(Date.now() - 10 * 24 * 3600 * 1000);

function build(stale: any[], dis: Record<string, any>, logs: any[] = []) {
  const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });
  const notificationModel: any = {
    find: jest.fn().mockReturnValue({
      select: () => ({ lean: async () => stale }),
    }),
    deleteMany,
    countDocuments: jest.fn().mockResolvedValue(0),
  };
  const diModel: any = {
    findOne: jest.fn((q: any) => ({
      select: () => ({ lean: async () => dis[q._id] ?? null }),
    })),
  };
  const logsDiModel: any = {
    findOne: jest.fn((q: any) => ({
      select: () => ({
        lean: async () =>
          logs.find((l) => l._idDi === q._idDi && l.idIgnore === q.idIgnore) ??
          null,
      }),
    })),
  };
  const svc = new NotificationPurgeService(
    notificationModel,
    diModel,
    logsDiModel,
  );
  return { svc, notificationModel, deleteMany };
}

/** Ids réellement passés à `deleteMany`. */
const deletedIds = (deleteMany: jest.Mock): string[] =>
  deleteMany.mock.calls[0]?.[0]?._id?.$in ?? [];

describe('NotificationPurgeService.run', () => {
  it('borne la recherche sur createdAt — JAMAIS un filtre vide', async () => {
    const { svc, notificationModel } = build([], {});
    await svc.run();
    const filter = notificationModel.find.mock.calls[0][0];
    expect(filter).toHaveProperty('createdAt.$lt');
    expect(filter.createdAt.$lt).toBeInstanceOf(Date);
    // Deux prédicats, et EXACTEMENT ces deux : l'ancienneté et l'état de
    // lecture. Un filtre vide viderait la cloche de tout le monde ; un filtre
    // sans `readAt` emporterait les non-lues (cf. le test suivant).
    expect(Object.keys(filter).sort()).toEqual(['createdAt', 'readAt']);
  });

  it('ÉPARGNE une non-lue ancienne (elle relève du seul TTL readAt)', async () => {
    const { svc, notificationModel } = build([], {});
    await svc.run();
    const filter = notificationModel.find.mock.calls[0][0];
    // `readAt: { $ne: null }` = « déjà lue ». Une non-lue (`readAt: null`) ne
    // peut donc pas entrer dans l'ensemble des candidates à la suppression.
    expect(filter.readAt).toEqual({ $ne: null });
  });

  it('supprime une notification ancienne ordinaire', async () => {
    const { svc, deleteMany } = build(
      [{ _id: 'n1', type: 'DI_PENDING2', diId: 'DI_a', createdAt: OLD }],
      {},
    );
    const res = await svc.run();
    expect(deletedIds(deleteMany)).toEqual(['n1']);
    expect(res.keptBlPending).toBe(0);
  });

  it('ÉPARGNE une relance BL dont le document manque encore', async () => {
    const { svc, deleteMany } = build(
      [{ _id: 'n1', type: 'DI_DOC_BL_PENDING', diId: 'DI_a', createdAt: OLD }],
      { DI_a: { _id: 'DI_a', status: 'WAITING_BL', ignoreCount: 0 } },
    );
    const res = await svc.run();
    expect(res.keptBlPending).toBe(1);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('purge la relance BL dès que le BL est déposé', async () => {
    const { svc, deleteMany } = build(
      [{ _id: 'n1', type: 'DI_DOC_BL_PENDING', diId: 'DI_a', createdAt: OLD }],
      {
        DI_a: {
          _id: 'DI_a',
          status: 'WAITING_BL',
          ignoreCount: 0,
          driveDocs: { BL: { driveFileId: 'abc' } },
        },
      },
    );
    await svc.run();
    expect(deletedIds(deleteMany)).toEqual(['n1']);
  });

  it('accepte le lien scalaire legacy comme preuve de dépôt', async () => {
    const { svc, deleteMany } = build(
      [{ _id: 'n1', type: 'DI_DOC_BL_PENDING', diId: 'DI_a', createdAt: OLD }],
      {
        DI_a: {
          _id: 'DI_a',
          status: 'WAITING_BL',
          ignoreCount: 0,
          bon_de_livraison: 'http://drive/x',
        },
      },
    );
    await svc.run();
    expect(deletedIds(deleteMany)).toEqual(['n1']);
  });

  it('une valeur driveDocs legacy (chaîne) ne vaut PAS dépôt → épargnée', async () => {
    const { svc } = build(
      [{ _id: 'n1', type: 'DI_DOC_BL_PENDING', diId: 'DI_a', createdAt: OLD }],
      {
        DI_a: {
          _id: 'DI_a',
          status: 'WAITING_BL',
          ignoreCount: 0,
          driveDocs: { BL: 'ancien.pdf' },
        },
      },
    );
    expect((await svc.run()).keptBlPending).toBe(1);
  });

  it('WAITING_FACTURE = BL déjà arrivé → purgée', async () => {
    const { svc, deleteMany } = build(
      [{ _id: 'n1', type: 'DI_DOC_BL_PENDING', diId: 'DI_a', createdAt: OLD }],
      { DI_a: { _id: 'DI_a', status: 'WAITING_FACTURE', ignoreCount: 0 } },
    );
    await svc.run();
    expect(deletedIds(deleteMany)).toEqual(['n1']);
  });

  it('statut legacy CLOSING sans BL → épargnée', async () => {
    const { svc } = build(
      [{ _id: 'n1', type: 'DI_DOC_BL_PENDING', diId: 'DI_a', createdAt: OLD }],
      { DI_a: { _id: 'DI_a', status: 'CLOSING', ignoreCount: 0 } },
    );
    expect((await svc.run()).keptBlPending).toBe(1);
  });

  it('RETOUR : BL présent dans logsdis → purgée (sinon conservée à jamais)', async () => {
    const { svc, deleteMany } = build(
      [{ _id: 'n1', type: 'DI_DOC_BL_PENDING', diId: 'DI_a', createdAt: OLD }],
      // La DI n'a AUCUN BL : sur un retour, `addBlPDF` n'écrit que le log.
      { DI_a: { _id: 'DI_a', status: 'WAITING_BL', ignoreCount: 2 } },
      [{ _idDi: 'DI_a', idIgnore: 2, bon_de_livraison: 'http://drive/x' }],
    );
    await svc.run();
    expect(deletedIds(deleteMany)).toEqual(['n1']);
  });

  it('RETOUR : BL absent du log du cycle → épargnée', async () => {
    const { svc } = build(
      [{ _id: 'n1', type: 'DI_DOC_BL_PENDING', diId: 'DI_a', createdAt: OLD }],
      { DI_a: { _id: 'DI_a', status: 'WAITING_BL', ignoreCount: 2 } },
      [{ _idDi: 'DI_a', idIgnore: 2 }],
    );
    expect((await svc.run()).keptBlPending).toBe(1);
  });

  it('DI introuvable ou supprimée → purgée (pas d’orphelin éternel)', async () => {
    const { svc, deleteMany } = build(
      [
        { _id: 'n1', type: 'DI_DOC_BL_PENDING', diId: 'DI_ghost', createdAt: OLD },
        { _id: 'n2', type: 'DI_DOC_BL_PENDING', diId: 'DI_del', createdAt: OLD },
      ],
      { DI_del: { _id: 'DI_del', status: 'WAITING_BL', isDeleted: true } },
    );
    await svc.run();
    expect(deletedIds(deleteMany).sort()).toEqual(['n1', 'n2']);
  });

  it('ne charge la DI qu’UNE fois par diId (lignes dupliquées par destinataire)', async () => {
    const stale = ['a', 'b', 'c'].map((k) => ({
      _id: k,
      type: 'DI_DOC_BL_PENDING',
      diId: 'DI_a',
      createdAt: OLD,
    }));
    const { svc } = build(stale, {
      DI_a: { _id: 'DI_a', status: 'WAITING_BL', ignoreCount: 0 },
    });
    const res = await svc.run();
    expect(res.keptBlPending).toBe(3);
  });

  it('SIMULATION : compte sans rien supprimer', async () => {
    const { svc, deleteMany } = build(
      [{ _id: 'n1', type: 'DI_PENDING2', diId: 'DI_a', createdAt: OLD }],
      {},
    );
    const res = await svc.run(true);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
  });
});
