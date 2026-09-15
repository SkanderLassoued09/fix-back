// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';

/**
 * Prix des pièces figés par phase (onglet Finances du dossier DI).
 *
 * Instance nue sur le prototype : la DI, sa ligne logsdis et le catalogue
 * vivent en mémoire ; les écritures positionnelles (`arrayFilters`) sont
 * rejouées sur ces objets. Les méthodes métier réelles s'exécutent.
 */

type Line = Record<string, any>;
type State = {
  di: { _id: string; ignoreCount: number; array_composants: Line[]; [k: string]: any };
  row: { idIgnore: number; array_composants: Line[] } | null;
  catalogue: Record<string, number>;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Rejoue `$set: { 'array_composants.$[e].<key>': v }` + `arrayFilters`. */
function applyArrayFilter(lines: Line[], update: any, options: any) {
  const [path, value] = Object.entries(update.$set)[0] as [string, number];
  const key = path.split('.').pop() as string;
  const filter = options.arrayFilters[0];
  for (const line of lines) {
    if (line.nameComposant !== filter['e.nameComposant']) continue;
    if (`e.${key}` in filter && line[key] != null) continue;
    line[key] = value;
  }
}

function makeSvc(state: State, opts: { catalogueDown?: boolean } = {}) {
  const svc: any = Object.create(DiService.prototype);
  const thenable = () =>
    Object.assign(Promise.resolve(clone(state.di)), {
      lean: jest.fn().mockResolvedValue(clone(state.di)),
      select: jest.fn().mockResolvedValue(clone(state.di)),
    });

  svc.diModel = {
    findOne: jest.fn().mockImplementation(thenable),
    findById: jest.fn().mockImplementation(() => Promise.resolve(clone(state.di))),
    findOneAndUpdate: jest.fn().mockImplementation(async (filter: any, update: any) => {
      for (const [k, v] of Object.entries(update.$set ?? {})) {
        if (k === 'array_composants.$.isUpdated') {
          const line = state.di.array_composants.find(
            (l) => l.nameComposant === filter['array_composants.nameComposant'],
          );
          if (!line) return null;
          line.isUpdated = v;
        } else {
          state.di[k] = clone(v);
        }
      }
      return clone(state.di);
    }),
    updateOne: jest.fn().mockImplementation(async (_f: any, update: any, options: any) => {
      applyArrayFilter(state.di.array_composants, update, options);
    }),
  };
  svc.logsDiService = {
    getLogsById: jest.fn().mockImplementation(async (idIgnore: number) =>
      state.row && state.row.idIgnore === idIgnore ? clone(state.row) : null,
    ),
    setSelectedComponentAsDoneLogs: jest
      .fn()
      .mockImplementation(async (_id: string, _cycle: number, name: string) => {
        const line = state.row?.array_composants.find((l) => l.nameComposant === name);
        if (line) line.isUpdated = true;
        return clone(state.row);
      }),
    setPartPriceSnapshot: jest
      .fn()
      .mockImplementation(
        async (_id: string, _cycle: number, key: string, name: string, price: number, onlyMissing: boolean) => {
          const filter: Record<string, unknown> = { 'e.nameComposant': name };
          if (onlyMissing) filter[`e.${key}`] = null;
          applyArrayFilter(
            state.row?.array_composants ?? [],
            { $set: { [`array_composants.$[e].${key}`]: price } },
            { arrayFilters: [filter] },
          );
        },
      ),
    tech_finishReperationLogs: jest.fn().mockResolvedValue({}),
    savePricing: jest.fn().mockResolvedValue({}),
  };
  svc.composantModel = {
    findOne: jest.fn().mockImplementation(async ({ name }: { name: string }) => {
      if (opts.catalogueDown) throw new Error('catalogue indisponible');
      return name in state.catalogue ? { name, prix_vente: state.catalogue[name] } : null;
    }),
  };
  svc.discordHookService = { sendDiPriceAssigned: jest.fn().mockResolvedValue(undefined) };
  svc.captureDiscordFailure = jest.fn();
  svc.operationalErrorService = { capture: jest.fn().mockResolvedValue(undefined) };
  svc.syncEmplacementStatsForChange = jest.fn().mockResolvedValue(undefined);
  svc.notificationGateway = { updateTicket: jest.fn() };
  return svc;
}

const cycle0 = (lines: Line[], catalogue: Record<string, number>): State => ({
  di: { _id: 'DI1', ignoreCount: 0, diagnosticPayant: true, array_composants: clone(lines) },
  row: { idIgnore: 0, array_composants: clone(lines) },
  catalogue,
});

const line = (state: State, where: 'di' | 'row', name: string) =>
  (where === 'di' ? state.di.array_composants : state.row!.array_composants).find(
    (l) => l.nameComposant === name,
  )!;

describe('Prix figé au diagnostic — validation magasin', () => {
  it('cycle 0 : prix catalogue figé sur la DI ET la ligne logsdis', async () => {
    const state = cycle0([{ nameComposant: 'A', quantity: 2 }], { A: 100 });
    const svc = makeSvc(state);

    await svc.setSelectedComponentAsDone('DI1', 'A');

    expect(line(state, 'di', 'A').isUpdated).toBe(true);
    expect(line(state, 'di', 'A').prixVenteDiag).toBe(100);
    expect(line(state, 'row', 'A').prixVenteDiag).toBe(100);
  });

  it('prix déjà figé → jamais écrasé par une hausse du catalogue', async () => {
    const state = cycle0([{ nameComposant: 'A', quantity: 2 }], { A: 100 });
    const svc = makeSvc(state);

    await svc.setSelectedComponentAsDone('DI1', 'A');
    state.catalogue.A = 150;
    await svc.setSelectedComponentAsDone('DI1', 'A');

    expect(line(state, 'di', 'A').prixVenteDiag).toBe(100);
    expect(line(state, 'row', 'A').prixVenteDiag).toBe(100);
  });

  it('cycle de retour : la ligne logsdis du cycle courant est écrite', async () => {
    const lines = [{ nameComposant: 'A', quantity: 1 }];
    const state: State = {
      di: { _id: 'DI1', ignoreCount: 1, array_composants: clone(lines) },
      row: { idIgnore: 1, array_composants: clone(lines) },
      catalogue: { A: 80 },
    };
    const svc = makeSvc(state);

    await svc.setSelectedComponentAsDone('DI1', 'A');

    expect(svc.logsDiService.setSelectedComponentAsDoneLogs).toHaveBeenCalledWith('DI1', 1, 'A');
    expect(svc.logsDiService.setPartPriceSnapshot).toHaveBeenCalledWith(
      'DI1', 1, 'prixVenteDiag', 'A', 80, true,
    );
    expect(line(state, 'row', 'A').prixVenteDiag).toBe(80);
    expect(line(state, 'di', 'A').prixVenteDiag).toBe(80);
  });
});

describe('Prix figé au diagnostic — tarification', () => {
  it('remplit les pièces jamais validées, sans écraser les autres', async () => {
    const state = cycle0(
      [
        { nameComposant: 'A', quantity: 1, prixVenteDiag: 100 },
        { nameComposant: 'B', quantity: 3 },
      ],
      { A: 150, B: 40 },
    );
    const svc = makeSvc(state);

    await svc.affectinitialPrice('DI1', 200);

    expect(line(state, 'di', 'A').prixVenteDiag).toBe(100);
    expect(line(state, 'di', 'B').prixVenteDiag).toBe(40);
    expect(line(state, 'row', 'B').prixVenteDiag).toBe(40);
  });
});

describe('Prix figé en fin de réparation', () => {
  it('prix catalogue actuel figé sur chaque ligne, prix diagnostic intact', async () => {
    const state = cycle0([{ nameComposant: 'A', quantity: 2, prixVenteDiag: 100 }], { A: 150 });
    const svc = makeSvc(state);

    await svc.tech_finishReperation('DI1', 'Carte remplacée');

    expect(line(state, 'di', 'A').prixVenteRep).toBe(150);
    expect(line(state, 'row', 'A').prixVenteRep).toBe(150);
    expect(line(state, 'di', 'A').prixVenteDiag).toBe(100);
  });

  it('catalogue indisponible → la fin de réparation aboutit, échec tracé', async () => {
    const state = cycle0([{ nameComposant: 'A', quantity: 2 }], { A: 150 });
    const svc = makeSvc(state, { catalogueDown: true });

    await expect(svc.tech_finishReperation('DI1', 'ok')).resolves.toBeDefined();
    expect(state.di.remarque_tech_repair).toBe('ok');
    expect(svc.operationalErrorService.capture).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'SNAPSHOT_PART_PRICES' }),
    );
  });
});

describe('updateDi — une liste renvoyée par le client garde les prix figés', () => {
  it('report par nom ; une nouvelle pièce reste sans prix', async () => {
    const state = cycle0(
      [{ nameComposant: 'A', quantity: 2, isUpdated: true, prixVenteDiag: 100, prixVenteRep: 150 }],
      {},
    );
    const svc = makeSvc(state);

    await svc.updateDi({
      _id: 'DI1',
      array_composants: [
        { nameComposant: 'A', quantity: 3, isUpdated: true },
        { nameComposant: 'C', quantity: 1, isUpdated: false },
      ],
    });

    expect(state.di.array_composants).toEqual([
      { nameComposant: 'A', quantity: 3, isUpdated: true, prixVenteDiag: 100, prixVenteRep: 150 },
      { nameComposant: 'C', quantity: 1, isUpdated: false },
    ]);
  });
});

describe('calculateTicketComposantPriceByPhase', () => {
  it('prix figés : diagnostic et réparation valorisés chacun à leur prix', async () => {
    const state = cycle0(
      [{ nameComposant: 'A', quantity: 2, prixVenteDiag: 100, prixVenteRep: 150 }],
      { A: 999 },
    );
    const svc = makeSvc(state);

    await expect(svc.calculateTicketComposantPriceByPhase('DI1', 0)).resolves.toEqual({
      diag: 200,
      rep: 300,
      diagRecorded: true,
    });
  });

  it('DI antérieure sans prix figé : prix catalogue actuel, diagRecorded faux', async () => {
    const state = cycle0([{ nameComposant: 'A', quantity: 2 }], { A: 120 });
    const svc = makeSvc(state);

    await expect(svc.calculateTicketComposantPriceByPhase('DI1', 0)).resolves.toEqual({
      diag: 240,
      rep: 240,
      diagRecorded: false,
    });
  });

  it('liste vide → 0 / 0, diagRecorded vrai', async () => {
    const state = cycle0([], {});
    const svc = makeSvc(state);

    await expect(svc.calculateTicketComposantPriceByPhase('DI1', 0)).resolves.toEqual({
      diag: 0,
      rep: 0,
      diagRecorded: true,
    });
  });

  it('cycle explicite sans ligne logsdis, hors cycle courant → aucune pièce', async () => {
    const state = cycle0([{ nameComposant: 'A', quantity: 2 }], { A: 120 });
    state.row = null;
    state.di.ignoreCount = 2;
    const svc = makeSvc(state);

    await expect(svc.calculateTicketComposantPriceByPhase('DI1', 1)).resolves.toEqual({
      diag: 0,
      rep: 0,
      diagRecorded: true,
    });
  });
});
