import { MagasinStockReminderService } from './magasin-stock-reminder.service';

/**
 * Rappel stock magasin — détection (rupture/bientôt-vide), seuil configurable,
 * UN seul résumé ERP vers le rôle Magasin, no-op quand rien n'est bas.
 */
function makeSvc(
  parts: Array<{ name?: string; quantity_stocked?: number }>,
): any {
  const svc: any = Object.create(MagasinStockReminderService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.notificationService = { emit: jest.fn().mockResolvedValue({}) };
  const chain: any = {
    sort: () => chain,
    lean: () => Promise.resolve(parts),
  };
  const find = jest.fn().mockReturnValue(chain);
  svc.composantModel = { find };
  return svc;
}

describe('MagasinStockReminderService.run', () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
    jest.clearAllMocks();
  });

  it('scinde rupture / bientôt-vide et émet UN résumé MAGASIN_STOCK_LOW au rôle Magasin', async () => {
    process.env.STOCK_LOW_THRESHOLD = '5';
    const svc = makeSvc([
      { name: 'A', quantity_stocked: 0 }, // rupture
      { name: 'B', quantity_stocked: 2 }, // bientôt vide
      { name: 'C', quantity_stocked: 5 }, // bientôt vide (borne)
    ]);
    const res = await svc.run();

    expect(res).toEqual(
      expect.objectContaining({ threshold: 5, rupture: 1, low: 2, notified: true }),
    );
    expect(svc.notificationService.emit).toHaveBeenCalledTimes(1);
    const arg = svc.notificationService.emit.mock.calls[0][0];
    expect(arg.type).toBe('MAGASIN_STOCK_LOW');
    expect(arg.notify).toEqual({ roles: ['Magasin'] });
    expect(arg.diId).toBeNull();
    expect(arg.payload.rupture).toEqual([{ name: 'A', quantity: 0 }]);
    expect(arg.payload.low).toEqual([
      { name: 'B', quantity: 2 },
      { name: 'C', quantity: 5 },
    ]);
    expect(arg.message).toContain('Rupture (1)');
    expect(arg.message).toContain('Bientôt vide ≤5 (2)');
  });

  it('requête filtrée : En stock/EnStock, non supprimé, quantité ≤ seuil', async () => {
    process.env.STOCK_LOW_THRESHOLD = '3';
    const svc = makeSvc([]);
    await svc.run();
    const q = svc.composantModel.find.mock.calls[0][0];
    expect(q.status_composant).toEqual({ $in: ['En stock', 'EnStock'] });
    expect(q.isDeleted).toEqual({ $ne: true });
    expect(q.quantity_stocked).toEqual({ $lte: 3 });
  });

  it('rien de bas → aucune notification', async () => {
    const svc = makeSvc([]);
    const res = await svc.run();
    expect(res.notified).toBe(false);
    expect(svc.notificationService.emit).not.toHaveBeenCalled();
  });

  it('seuil par défaut = 5 quand STOCK_LOW_THRESHOLD absent', async () => {
    delete process.env.STOCK_LOW_THRESHOLD;
    const svc = makeSvc([]);
    const res = await svc.run();
    expect(res.threshold).toBe(5);
    expect(svc.composantModel.find.mock.calls[0][0].quantity_stocked).toEqual({
      $lte: 5,
    });
  });
});
