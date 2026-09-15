// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';

/**
 * COÛT DES PIÈCES PAR CYCLE — `calculateTicketComposantPrice(_id, idIgnore)`.
 *
 * L'onglet Finances du modal « Dossier » affiche le coût des pièces du cycle
 * CONSULTÉ. Sans argument, la query ne connaît que le cycle courant ; et le
 * catalogue du front exclut les composants soft-supprimés (DI19 cycle 2 :
 * 0 au lieu de 505). Ces tests figent la lecture par cycle, le repli sur le
 * miroir limité au cycle courant, et la tarification des pièces
 * soft-supprimées.
 */

const CATALOG: Record<string, { prix_vente: number; isDeleted?: boolean }> = {
  '47µF 50V ': { prix_vente: 2, isDeleted: true },
  stgips14k60t: { prix_vente: 500.25, isDeleted: true },
  resist: { prix_vente: 0.75, isDeleted: true },
  'HS-600-24': { prix_vente: 390 },
};

/** Pièces réelles de DI19 au cycle 2 — toutes soft-supprimées depuis. */
const CYCLE2 = [
  { nameComposant: '47µF 50V ', quantity: 2 },
  { nameComposant: 'stgips14k60t', quantity: 1 },
  { nameComposant: 'resist', quantity: 1 },
];

function makeSvc(di: any, rows: Record<number, any> = {}) {
  const svc: any = Object.create(DiService.prototype);
  svc.diModel = { findById: jest.fn().mockResolvedValue(di) };
  svc.composantModel = {
    findOne: jest
      .fn()
      .mockImplementation(({ name }: { name: string }) =>
        Promise.resolve(CATALOG[name] ?? null),
      ),
  };
  svc.logsDiService = {
    getLogsById: jest
      .fn()
      .mockImplementation((idIgnore: number) =>
        Promise.resolve(rows[idIgnore] ?? null),
      ),
    calculateComposantTicketPrice: jest.fn().mockResolvedValue(42),
  };
  return svc;
}

describe('calculateTicketComposantPrice — cycle explicite', () => {
  it('tarifie les pièces de la ligne du cycle demandé, soft-supprimées comprises', async () => {
    const svc = makeSvc(
      { _id: 'DI19', ignoreCount: 2, array_composants: [] },
      { 2: { array_composants: CYCLE2 } },
    );

    const total = await svc.calculateTicketComposantPrice('DI19', 2);

    expect(total).toBeCloseTo(505, 6);
    expect(svc.logsDiService.getLogsById).toHaveBeenCalledWith(2, 'DI19');
  });

  it('cycle PASSÉ sans ligne → 0, jamais les pièces du miroir (autre cycle)', async () => {
    const svc = makeSvc({
      _id: 'DI19',
      ignoreCount: 2,
      array_composants: [{ nameComposant: 'HS-600-24', quantity: 1 }],
    });

    expect(await svc.calculateTicketComposantPrice('DI19', 0)).toBe(0);
    expect(svc.composantModel.findOne).not.toHaveBeenCalled();
  });

  it('cycle COURANT sans ligne → miroir DI (il est le miroir de ce cycle)', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      ignoreCount: 0,
      array_composants: [{ nameComposant: 'HS-600-24', quantity: 2 }],
    });

    expect(await svc.calculateTicketComposantPrice('DI1', 0)).toBe(780);
  });

  it('ligne présente mais vide ([] = sans PDR) → 0, sans repli sur le miroir', async () => {
    const svc = makeSvc(
      {
        _id: 'DI1',
        ignoreCount: 1,
        array_composants: [{ nameComposant: 'HS-600-24', quantity: 1 }],
      },
      { 1: { array_composants: [] } },
    );

    expect(await svc.calculateTicketComposantPrice('DI1', 1)).toBe(0);
  });

  it('nom introuvable ou quantité absente → la ligne compte 0', async () => {
    const svc = makeSvc(
      { _id: 'DI1', ignoreCount: 0 },
      {
        0: {
          array_composants: [
            { nameComposant: 'inconnu', quantity: 3 },
            { nameComposant: 'HS-600-24' },
            { nameComposant: 'resist', quantity: 4 },
          ],
        },
      },
    );

    expect(await svc.calculateTicketComposantPrice('DI1', 0)).toBe(3);
  });
});

describe('calculateTicketComposantPrice — sans cycle (comportement historique)', () => {
  it('flux original → pièces du miroir DI', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      ignoreCount: 0,
      array_composants: [{ nameComposant: 'HS-600-24', quantity: 1 }],
    });

    expect(await svc.calculateTicketComposantPrice('DI1')).toBe(390);
    expect(svc.logsDiService.getLogsById).not.toHaveBeenCalled();
  });

  it('en retour → délègue au cycle courant des logs', async () => {
    const svc = makeSvc({ _id: 'DI19', ignoreCount: 2, array_composants: [] });

    expect(await svc.calculateTicketComposantPrice('DI19')).toBe(42);
    expect(
      svc.logsDiService.calculateComposantTicketPrice,
    ).toHaveBeenCalledWith('DI19', 2);
  });
});
