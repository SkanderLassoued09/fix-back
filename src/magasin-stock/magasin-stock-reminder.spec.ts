import { MagasinStockReminderService } from './magasin-stock-reminder.service';

/**
 * Rappel matinal du magasin — §1 stock bas (rupture/bientôt-vide, seuil
 * configurable) et §2 fiches à compléter (champ clé vide). UN résumé ERP par
 * sujet vers le rôle Magasin, un post Discord qui reprend les deux, et un
 * silence complet quand le catalogue est sain.
 */

/** `run()` fait DEUX requêtes : §1 le stock bas, puis §2 le catalogue complet.
 *  Le mock les sert dans cet ordre (`catalogue` vide par défaut = catalogue
 *  sain, pour que les cas §1 restent isolés de §2). */
function makeSvc(
  parts: Array<{ name?: string; quantity_stocked?: number }>,
  catalogue: Array<Record<string, unknown>> = [],
): any {
  const svc: any = Object.create(MagasinStockReminderService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.notificationService = { emit: jest.fn().mockResolvedValue({}) };
  svc.discordHookService = {
    sendMagasinStockReminder: jest.fn().mockResolvedValue(undefined),
  };
  const results = [parts, catalogue];
  let call = 0;
  const chain: any = {
    sort: () => chain,
    lean: () => Promise.resolve(results[call++] ?? []),
  };
  const find = jest.fn().mockReturnValue(chain);
  svc.composantModel = { find };
  return svc;
}

/** Raccourci : une fiche COMPLÈTE (aucun motif « à compléter »). */
const complete = (name: string, qty = 7) => ({
  name,
  status_composant: 'En stock',
  prix_achat: 1,
  prix_vente: 2,
  quantity_stocked: qty,
});

/** Le dernier argument passé à `emit` pour un type donné. */
const emitOf = (svc: any, type: string) =>
  svc.notificationService.emit.mock.calls
    .map((c: any[]) => c[0])
    .find((a: any) => a.type === type);

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

describe('MagasinStockReminderService.run — §2 fiches à compléter', () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
    jest.clearAllMocks();
  });

  it('statut vide : le littéral "undefined", "null", "", null et le champ absent comptent tous', async () => {
    const svc = makeSvc([], [
      { name: 'A', status_composant: 'undefined', prix_achat: 1, prix_vente: 2, quantity_stocked: 3 },
      { name: 'B', status_composant: 'null', prix_achat: 1, prix_vente: 2, quantity_stocked: 3 },
      { name: 'C', status_composant: '', prix_achat: 1, prix_vente: 2, quantity_stocked: 3 },
      { name: 'D', status_composant: null, prix_achat: 1, prix_vente: 2, quantity_stocked: 3 },
      { name: 'E', prix_achat: 1, prix_vente: 2, quantity_stocked: 3 }, // champ absent
      complete('OK'),
    ]);

    const res = await svc.run();

    expect(res.incomplete).toEqual({ status: 5, price: 0, qty: 0, affected: 5 });
    expect(res.incompleteNotified).toBe(true);

    const arg = emitOf(svc, 'MAGASIN_STOCK_INCOMPLETE');
    expect(arg.notify).toEqual({ roles: ['Magasin'] });
    expect(arg.diId).toBeNull();
    expect(arg.actorId).toBeNull();
    expect(arg.payload.affected).toBe(5);
    expect(arg.payload.statusMissing.map((p: any) => p.name)).toEqual([
      'A', 'B', 'C', 'D', 'E',
    ]);
    expect(arg.message).toContain('Composants à compléter (5)');
    expect(arg.message).toContain('Statut (5)');
    // 'OK' est complet : il ne doit apparaître nulle part.
    expect(arg.message).not.toContain('OK');
  });

  it('0 est une valeur RENSEIGNÉE : prix nul et stock épuisé ne sont pas « vides »', async () => {
    const svc = makeSvc([], [
      { name: 'GRATUIT', status_composant: 'En stock', prix_achat: 0, prix_vente: 0, quantity_stocked: 0 },
    ]);

    const res = await svc.run();

    expect(res.incomplete).toEqual({ status: 0, price: 0, qty: 0, affected: 0 });
    expect(res.incompleteNotified).toBe(false);
    expect(emitOf(svc, 'MAGASIN_STOCK_INCOMPLETE')).toBeUndefined();
  });

  it('prix : un seul des deux manquant suffit ; quantité non numérique = vide', async () => {
    const svc = makeSvc([], [
      { name: 'SANS_ACHAT', status_composant: 'En stock', prix_vente: 2, quantity_stocked: 1 },
      { name: 'SANS_VENTE', status_composant: 'En stock', prix_achat: 1, quantity_stocked: 1 },
      { name: 'QTE_TEXTE', status_composant: 'En stock', prix_achat: 1, prix_vente: 2, quantity_stocked: 'undefined' },
    ]);

    const res = await svc.run();

    expect(res.incomplete).toEqual({ status: 0, price: 2, qty: 1, affected: 3 });
    const arg = emitOf(svc, 'MAGASIN_STOCK_INCOMPLETE');
    expect(arg.payload.priceMissing.map((p: any) => p.name)).toEqual([
      'SANS_ACHAT', 'SANS_VENTE',
    ]);
    expect(arg.payload.qtyMissing.map((p: any) => p.name)).toEqual(['QTE_TEXTE']);
    // Quantité absente → `null`, jamais 0 : « épuisé » ≠ « non renseigné ».
    expect(arg.payload.qtyMissing[0].quantity).toBeNull();
  });

  it('la section Prix ne montre PAS la quantité : « 7805 (0) » se lirait comme un prix nul', async () => {
    // Statut ET prix vides, quantité renseignée à 0 : la même pièce apparaît
    // dans les deux sections, annotée dans l'une et pas dans l'autre.
    const svc = makeSvc([], [{ name: 'SANS_TOUT', quantity_stocked: 0 }]);

    await svc.run();

    const msg = emitOf(svc, 'MAGASIN_STOCK_INCOMPLETE').message;
    // Motif « statut » : annotation CONSERVÉE — elle révèle le stock réel resté
    // invisible faute de statut.
    expect(msg).toContain('Statut (1) : SANS_TOUT (0)');
    // Motif « prix » : annotation RETIRÉE, sinon « SANS_TOUT (0) » à côté du
    // libellé « Prix » se lit comme un prix nul.
    expect(msg).toContain('Prix (1) : SANS_TOUT');
    expect(msg).not.toContain('Prix (1) : SANS_TOUT (0)');
  });

  it('une fiche cumulant les 3 motifs est comptée UNE fois dans affected', async () => {
    const svc = makeSvc([], [{ name: 'ORPHELINE' }]);

    const res = await svc.run();

    expect(res.incomplete).toEqual({ status: 1, price: 1, qty: 1, affected: 1 });
    const arg = emitOf(svc, 'MAGASIN_STOCK_INCOMPLETE');
    expect(arg.message).toContain('Composants à compléter (1)');
    expect(arg.message).toContain('Statut (1)');
    expect(arg.message).toContain('Prix (1)');
    expect(arg.message).toContain('Quantité (1)');
  });

  it('§2 balaye le catalogue vivant entier, sans filtre de statut ni de quantité', async () => {
    const svc = makeSvc([], []);
    await svc.run();

    expect(svc.composantModel.find).toHaveBeenCalledTimes(2);
    const q = svc.composantModel.find.mock.calls[1][0];
    expect(q).toEqual({ isDeleted: { $ne: true } });
    // Projection réduite : le balayage ne doit pas tirer tout le document.
    expect(svc.composantModel.find.mock.calls[1][1]).toEqual({
      name: 1,
      status_composant: 1,
      prix_achat: 1,
      prix_vente: 1,
      quantity_stocked: 1,
    });
  });

  it('le stock bas conserve son type propre : §1 et §2 sont deux notifications distinctes', async () => {
    const svc = makeSvc(
      [{ name: 'BAS', quantity_stocked: 0 }],
      [{ name: 'VIDE' }],
    );

    const res = await svc.run();

    expect(res.notified).toBe(true);
    expect(res.incompleteNotified).toBe(true);
    expect(svc.notificationService.emit).toHaveBeenCalledTimes(2);
    expect(emitOf(svc, 'MAGASIN_STOCK_LOW')).toBeDefined();
    expect(emitOf(svc, 'MAGASIN_STOCK_INCOMPLETE')).toBeDefined();
  });

  it('stock bas seul (catalogue sain) → MAGASIN_STOCK_LOW seul', async () => {
    const svc = makeSvc([{ name: 'BAS', quantity_stocked: 1 }], [complete('OK')]);

    const res = await svc.run();

    expect(res.notified).toBe(true);
    expect(res.incompleteNotified).toBe(false);
    expect(svc.notificationService.emit).toHaveBeenCalledTimes(1);
    expect(emitOf(svc, 'MAGASIN_STOCK_LOW')).toBeDefined();
  });
});

describe('MagasinStockReminderService.run — Discord', () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
    jest.clearAllMocks();
  });

  it('poste UN embed reprenant les deux sujets', async () => {
    process.env.STOCK_LOW_THRESHOLD = '5';
    const svc = makeSvc(
      [{ name: 'BAS', quantity_stocked: 0 }],
      [{ name: 'VIDE' }],
    );

    const res = await svc.run();

    expect(res.discordSent).toBe(true);
    expect(svc.discordHookService.sendMagasinStockReminder).toHaveBeenCalledTimes(1);
    const arg = svc.discordHookService.sendMagasinStockReminder.mock.calls[0][0];
    expect(arg.threshold).toBe(5);
    expect(arg.rupture.count).toBe(1);
    expect(arg.low.count).toBe(0);
    expect(arg.incomplete.affected).toBe(1);
  });

  it('catalogue sain et stock plein → aucune notification, aucun post Discord', async () => {
    const svc = makeSvc([], [complete('OK')]);

    const res = await svc.run();

    expect(res.notified).toBe(false);
    expect(res.incompleteNotified).toBe(false);
    expect(res.discordSent).toBe(false);
    expect(svc.notificationService.emit).not.toHaveBeenCalled();
    expect(svc.discordHookService.sendMagasinStockReminder).not.toHaveBeenCalled();
  });

  it('un échec Discord ne casse pas le rappel : la cloche reste émise', async () => {
    const svc = makeSvc([{ name: 'BAS', quantity_stocked: 0 }], []);
    svc.discordHookService.sendMagasinStockReminder.mockRejectedValue(
      new Error('webhook 500'),
    );

    const res = await svc.run();

    expect(res.notified).toBe(true);
    expect(res.discordSent).toBe(false);
    expect(emitOf(svc, 'MAGASIN_STOCK_LOW')).toBeDefined();
    expect(svc.logger.warn).toHaveBeenCalled();
  });

  it('un échec de la cloche §1 n\'empêche ni §2 ni Discord', async () => {
    const svc = makeSvc([{ name: 'BAS', quantity_stocked: 0 }], [{ name: 'VIDE' }]);
    svc.notificationService.emit
      .mockRejectedValueOnce(new Error('mongo down'))
      .mockResolvedValue({});

    const res = await svc.run();

    expect(res.notified).toBe(false);
    expect(res.incompleteNotified).toBe(true);
    expect(res.discordSent).toBe(true);
  });
});
