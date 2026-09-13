// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { STATUS_DI } from './di.status';

/**
 * FT-05 — RETOUR + erreur Fixtronix + réparable + SANS PDR doit finir en PENDING3.
 *
 * Ce fichier reproduit l'état que la PRODUCTION produit réellement, et c'est tout
 * l'intérêt : les specs existants amorçaient la DI avec `isErrorFromFixtronix:
 * true` SUR LE DOCUMENT DI — un état que le flux normal ne crée jamais, puisque
 * la case « Erreur Fixtronix » n'est affichée qu'en retour et que, en retour,
 * `tech_startDiagnostic` n'écrivait QUE la ligne de cycle. Ils étaient donc verts
 * alors que la DI partait en PENDING2 → PRICING_DIAG → WAITING_DEVIS, c.-à-d.
 * facturée au client pour une faute Fixtronix.
 */

function makeSvc(di: any, cycleLog: any) {
  const svc: any = Object.create(DiService.prototype);
  svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
  // Mongoose renvoie une Query : « thenable » ET chaînable (.lean/.select).
  // Un mock qui n'offre que .lean() fait résoudre `await findOne()` sur la Query
  // elle-même, et le code sous test lit alors des champs `undefined`.
  const query = () => {
    const q: any = Promise.resolve(di);
    q.lean = () => Promise.resolve(di);
    q.select = () => query();
    return q;
  };
  svc.diModel = {
    findOne: jest.fn().mockImplementation(query),
    findOneAndUpdate: jest.fn().mockImplementation((_f: any, update: any) =>
      Promise.resolve({
        ...di,
        status: update?.$set?.status,
        ignoreCount: di.ignoreCount ?? 0,
      }),
    ),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
  svc.statsService = {
    updateStatus: jest.fn().mockResolvedValue(undefined),
    closeDiagLeg: jest.fn().mockResolvedValue(null),
  };
  svc.logsDiService = {
    getLogsById: jest.fn().mockResolvedValue(cycleLog),
    tech_startDiagnostic: jest.fn().mockResolvedValue({ ...cycleLog }),
    // Chemin d'ecriture unique : la ligne de cycle ET le miroir DI.
    upsertCycle: jest.fn().mockResolvedValue({ ...cycleLog }),
    closeCycle: jest.fn().mockResolvedValue(null),
  };
  svc.discordHookService = {
    sendDiInMagasin: jest.fn().mockResolvedValue(undefined),
    sendDiStatusPending2: jest.fn().mockResolvedValue(undefined),
    sendDiagnosticFinished: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = {
    updateTicket: jest.fn(),
    sendNotifcationToAdmins: jest.fn(),
  };
  svc.emitDiHandoff = jest.fn().mockResolvedValue(undefined);
  svc.captureDiscordFailure = jest.fn();
  svc.operationalErrorService = { capture: jest.fn().mockResolvedValue(null) };
  svc.closeIrreparable = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ ...di, status: STATUS_DI.Irreparable.status }),
    );
  svc.magasinTech_Pending3 = jest
    .fn()
    .mockResolvedValue({ ...di, status: STATUS_DI.Pending3.status });
  svc.magasinTech_Pending2 = jest
    .fn()
    .mockResolvedValue({ ...di, status: STATUS_DI.Pending2.status });
  return svc;
}

/**
 * L'état réel d'un retour AVANT correctif : le verdict Fixtronix vit UNIQUEMENT
 * sur la ligne de cycle ; le document DI porte encore celui du cycle 0 (false).
 */
const PROD_RETOUR_DI = {
  _id: 'DI1',
  _idnum: 'DI1',
  status: STATUS_DI.InDiagnostic.status,
  ignoreCount: 1,
  can_be_repaired: true,
  contain_pdr: false,
  array_composants: [],
  isErrorFromFixtronix: false, // ← cycle 0, jamais réécrit par le retour
};

const FIXTRONIX_LOG = {
  idIgnore: 1,
  can_be_repaired: true,
  contain_pdr: false,
  array_composants: [],
  isErrorFromFixtronix: true, // ← le tech vient de cocher la case
};

describe('FT-05 — le verdict du cycle retour doit survivre jusqu’au routeur', () => {
  it('tech_startDiagnostic écrit le verdict sur la DI AUSSI en retour', async () => {
    const svc = makeSvc({ ...PROD_RETOUR_DI }, { ...FIXTRONIX_LOG });

    await svc.tech_startDiagnostic('DI1', {
      can_be_repaired: true,
      contain_pdr: false,
      isErrorFromFixtronix: true,
      array_composants: [],
      di_category_id: 'CAT',
      remarque_tech_diagnostic: 'RAS',
    });

    // Le miroir DI porte le verdict du cycle COURANT (c'est lui que le routeur
    // Fixtronix lit) …
    const [, mirror] = svc.diModel.updateOne.mock.calls[0];
    expect(mirror.$set.isErrorFromFixtronix).toBe(true);
    expect(mirror.$set.can_be_repaired).toBe(true);

    // … et la ligne du cycle 1 porte EXACTEMENT le meme verdict : c'est elle
    // qui restera l'archive du retour une fois le cycle suivant ouvert.
    const [diId, cycle, patch] = svc.logsDiService.upsertCycle.mock.calls[0];
    expect(diId).toBe('DI1');
    expect(cycle).toBe(1);
    expect(patch.isErrorFromFixtronix).toBe(true);
    expect(patch.can_be_repaired).toBe(true);
  });

  it('n’A-RÉARME PAS le décrément de stock en retour (sinon double décrément)', async () => {
    const svc = makeSvc({ ...PROD_RETOUR_DI }, { ...FIXTRONIX_LOG });

    await svc.tech_startDiagnostic('DI1', {
      can_be_repaired: true,
      contain_pdr: true,
      isErrorFromFixtronix: true,
      array_composants: [{ nameComposant: 'Fusible', quantity: 2 }],
      di_category_id: 'CAT',
      remarque_tech_diagnostic: 'RAS',
    });

    const [, mirror] = svc.diModel.updateOne.mock.calls[0];
    // En retour le marqueur est ré-armé à l'ouverture du cycle
    // (RETOUR_CYCLE_RESET) ; le décrément unique passe par
    // commitStockDecrementOnce.
    expect(mirror.$set).not.toHaveProperty('stockDecrementedAt');
    const [, , patch] = svc.logsDiService.upsertCycle.mock.calls[0];
    expect(patch).not.toHaveProperty('stockDecrementedAt');
  });

  it('le flux ORIGINAL ré-arme toujours le décrément de stock', async () => {
    const svc = makeSvc(
      { ...PROD_RETOUR_DI, ignoreCount: 0 },
      { ...FIXTRONIX_LOG },
    );

    await svc.tech_startDiagnostic('DI1', {
      can_be_repaired: true,
      contain_pdr: true,
      isErrorFromFixtronix: false,
      array_composants: [{ nameComposant: 'Fusible', quantity: 2 }],
      di_category_id: 'CAT',
      remarque_tech_diagnostic: 'RAS',
    });

    const [, mirror] = svc.diModel.updateOne.mock.calls[0];
    expect(mirror.$set.stockDecrementedAt).toBeNull();
    // Le flux original ecrit desormais LUI AUSSI sa ligne de cycle (cycle 0) :
    // c'est ce qui donne au dossier « Flux original » un support propre, au
    // lieu de lire la DI que les cycles suivants ecrasaient.
    const [, cycle] = svc.logsDiService.upsertCycle.mock.calls[0];
    expect(cycle).toBe(0);
  });

  it('une pause avec la case DÉCOCHÉE n’efface pas un verdict déjà posé', async () => {
    // Le formulaire vaut `false` par défaut et repart à chaque pause : sans
    // règle collante, une pause prise avant l'étape Validation effaçait le
    // verdict et la DI repartait en facturation.
    const svc = makeSvc(
      { ...PROD_RETOUR_DI, isErrorFromFixtronix: true },
      { ...FIXTRONIX_LOG },
    );

    await svc.tech_startDiagnostic('DI1', {
      can_be_repaired: true,
      contain_pdr: false,
      isErrorFromFixtronix: false, // ← case décochée / non atteinte
      array_composants: [],
      di_category_id: 'CAT',
      remarque_tech_diagnostic: 'RAS',
    });

    const [, mirror] = svc.diModel.updateOne.mock.calls[0];
    expect(mirror.$set.isErrorFromFixtronix).toBe(true);
    // La ligne de cycle porte la MÊME valeur que le miroir — invariant du
    // chemin d'écriture unique.
    const [, , patch] = svc.logsDiService.upsertCycle.mock.calls[0];
    expect(patch.isErrorFromFixtronix).toBe(true);
  });

  it('un retour dont la faute est CLIENT reste à false', async () => {
    const svc = makeSvc(
      { ...PROD_RETOUR_DI },
      { ...FIXTRONIX_LOG, isErrorFromFixtronix: false },
    );

    await svc.tech_startDiagnostic('DI1', {
      can_be_repaired: true,
      contain_pdr: false,
      isErrorFromFixtronix: false,
      array_composants: [],
      di_category_id: 'CAT',
      remarque_tech_diagnostic: 'RAS',
    });

    const [, mirror] = svc.diModel.updateOne.mock.calls[0];
    expect(mirror.$set.isErrorFromFixtronix).toBe(false);
  });

  it('changeStatusPending2 route vers PENDING3, JAMAIS PENDING2', async () => {
    const svc = makeSvc({ ...PROD_RETOUR_DI }, { ...FIXTRONIX_LOG });

    await svc.changeStatusPending2('DI1');

    expect(svc.magasinTech_Pending3).toHaveBeenCalledWith('DI1');
    expect(svc.magasinTech_Pending2).not.toHaveBeenCalled();
    const wrotePending2 = svc.diModel.findOneAndUpdate.mock.calls.some(
      ([, u]: any[]) => u?.$set?.status === STATUS_DI.Pending2.status,
    );
    expect(wrotePending2).toBe(false);
  });

  it('changeStatusPricing REFUSE de facturer un retour Fixtronix', async () => {
    const svc = makeSvc(
      { ...PROD_RETOUR_DI, status: STATUS_DI.Pending2.status },
      { ...FIXTRONIX_LOG },
    );

    await expect(svc.changeStatusPricing('DI1')).rejects.toThrow(
      /erreur Fixtronix/i,
    );
    expect(svc.operationalErrorService.capture).toHaveBeenCalled();
  });

  it('changeStatusPricing laisse passer un retour dont la faute est CLIENT', async () => {
    const svc = makeSvc(
      { ...PROD_RETOUR_DI, status: STATUS_DI.Pending2.status },
      { ...FIXTRONIX_LOG, isErrorFromFixtronix: false },
    );

    await expect(svc.changeStatusPricing('DI1')).resolves.toBeDefined();
  });
});
