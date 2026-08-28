// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { STATUS_DI } from './di.status';

/**
 * SORTIE MAGASIN d'un RETOUR « erreur Fixtronix » (FT-04, 2e saut).
 *
 * Règle argent : une erreur Fixtronix (notre faute) n'est JAMAIS facturée. Le cas
 * RETOUR + Fixtronix + réparable + AVEC PDR passe par le magasin (il y a des
 * pièces à préparer) ; à la SORTIE du magasin, la garde Fixtronix de la sortie de
 * DIAGNOSTIC ne s'appliquait plus (la source n'est plus un statut de diagnostic)
 * et la DI filait en PENDING2 → PRICING_DIAG, donc FACTURÉE.
 *
 * Elle doit désormais repartir vers la poignée de main composants
 * (CONFIRMATION → … → PENDING3), magasin conservé, tarification sautée, avec
 * `needsDevisBeforeRepair` posé comme sur le raccourci SANS PDR.
 *
 * Les DEUX portes vers PENDING2 depuis MagasinEstimation sont couvertes :
 * `changeStatusPending2` (bouton magasin « Terminer l'estimation ») et
 * `magasinTech_Pending2` (mutation exposée telle quelle par le resolver).
 */

function makeSvc(di: any, cycleLog: any) {
  const svc: any = Object.create(DiService.prototype);
  svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
  svc.diModel = {
    findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(di) }),
    // Rejoue le `$set.status` demandé pour que l'assertion porte sur la CIBLE.
    findOneAndUpdate: jest.fn().mockImplementation((_f: any, update: any) =>
      Promise.resolve({
        ...di,
        status: update?.$set?.status,
        ignoreCount: di.ignoreCount ?? 0,
      }),
    ),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
  svc.diWorkflowService = {
    transition: jest.fn().mockImplementation((input: any) =>
      Promise.resolve({
        di: { ...di, _idnum: 'T1', status: STATUS_DI.Pending2.status },
        transitionKey: input.transitionKey,
      }),
    ),
  };
  svc.statsService = {
    updateStatus: jest.fn().mockResolvedValue(undefined),
    closeDiagLeg: jest.fn().mockResolvedValue(null),
  };
  svc.logsDiService = { getLogsById: jest.fn().mockResolvedValue(cycleLog) };
  svc.discordHookService = {
    sendDiInMagasin: jest.fn().mockResolvedValue(undefined),
    sendDiStatusPending2: jest.fn().mockResolvedValue(undefined),
    sendDiagnosticFinished: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = { updateTicket: jest.fn() };
  svc.emitDiHandoff = jest.fn().mockResolvedValue(undefined);
  svc.captureDiscordFailure = jest.fn();
  // Clôture IRREPARABLE — on n'exerce pas son détail ici (couvert ailleurs),
  // seulement le fait que le routage y mène.
  svc.closeIrreparable = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ ...di, status: STATUS_DI.Irreparable.status }),
    );
  return svc;
}

/**
 * Variante pour les tests de ROUTAGE : les méthodes de destination sont stubées
 * pour qu'on assert « où va la DI », pas leur implémentation. À n'utiliser QUE
 * là — les stuber dans `makeSvc` masquerait la méthode sous test des autres blocs.
 */
function makeRoutingSvc(di: any, cycleLog: any) {
  const svc = makeSvc(di, cycleLog);
  svc.magasinTech_Pending3 = jest
    .fn()
    .mockResolvedValue({ ...di, status: STATUS_DI.Pending3.status });
  svc.magasinTech_Pending2 = jest
    .fn()
    .mockResolvedValue({ ...di, status: STATUS_DI.Pending2.status });
  svc.changeStatusMagasinEstimation = jest
    .fn()
    .mockResolvedValue({ ...di, status: STATUS_DI.MagasinEstimation.status });
  return svc;
}

/** DI en cours de DIAGNOSTIC sur un cycle RETOUR. */
const inDiagRetour = (over: Record<string, any> = {}) => ({
  _id: 'DI1',
  _idnum: 'DI1',
  status: STATUS_DI.InDiagnostic.status,
  ignoreCount: 1,
  can_be_repaired: true,
  contain_pdr: false,
  array_composants: [],
  ...over,
});

/** DI garée en MagasinEstimation, prête à sortir du magasin. */
const atMagasin = (over: Record<string, any> = {}) => ({
  _id: 'DI1',
  _idnum: 'DI1',
  status: STATUS_DI.MagasinEstimation.status,
  ignoreCount: 1,
  can_be_repaired: true,
  contain_pdr: true,
  array_composants: [{ nameComposant: 'Fusible', quantity: 1 }],
  ...over,
});

const FIXTRONIX_LOG = {
  contain_pdr: true,
  array_composants: [{ nameComposant: 'Fusible', quantity: 1 }],
  isErrorFromFixtronix: true,
};
const CLIENT_LOG = { ...FIXTRONIX_LOG, isErrorFromFixtronix: false };
/** Snapshot de cycle SANS pièce — le cas « sans PDR » du flux retour. */
const NO_PDR_LOG = {
  can_be_repaired: true,
  contain_pdr: false,
  array_composants: [],
  isErrorFromFixtronix: false,
};

describe('DiService — sortie magasin d’un RETOUR Fixtronix (FT-04)', () => {
  describe('changeStatusPending2 (bouton « Terminer l’estimation » du magasin)', () => {
    it('RETOUR + Fixtronix (flag DI persistant) → CONFIRMATION, JAMAIS PENDING2', async () => {
      const svc = makeSvc(
        atMagasin({ isErrorFromFixtronix: true }),
        // Log du cycle CLOBBERÉ à false par le formulaire : le flag DI doit gagner.
        CLIENT_LOG,
      );

      const out = await svc.changeStatusPending2('DI1');

      expect(out?.status).toBe(STATUS_DI.InMagasin.status); // 'CONFIRMATION'
      expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'DI1' },
        { $set: { status: STATUS_DI.InMagasin.status } },
        { new: true },
      );
      // La tarification n'est jamais atteinte.
      expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({ status: STATUS_DI.Pending2.status }),
        }),
        expect.anything(),
      );
      // Devis attendu de la coordinatrice avant l'envoi en réparation.
      expect(svc.diModel.updateOne).toHaveBeenCalledWith(
        { _id: 'DI1' },
        { $set: { needsDevisBeforeRepair: true } },
      );
    });

    it('RETOUR + Fixtronix porté par le SNAPSHOT du cycle (flag DI absent) → CONFIRMATION', async () => {
      const svc = makeSvc(atMagasin(), FIXTRONIX_LOG);

      const out = await svc.changeStatusPending2('DI1');

      expect(svc.logsDiService.getLogsById).toHaveBeenCalledWith(1, 'DI1');
      expect(out?.status).toBe(STATUS_DI.InMagasin.status);
    });

    it('RETOUR + erreur CLIENT → PENDING2 (non-régression : le client reste facturé)', async () => {
      const svc = makeSvc(atMagasin(), CLIENT_LOG);

      const out = await svc.changeStatusPending2('DI1');

      expect(out?.status).toBe(STATUS_DI.Pending2.status);
      expect(svc.diModel.updateOne).not.toHaveBeenCalled();
    });

    it('FLUX ORIGINAL (ignoreCount = 0), même avec le flag Fixtronix → PENDING2 (garde bornée au retour)', async () => {
      const svc = makeSvc(
        atMagasin({ ignoreCount: 0, isErrorFromFixtronix: true }),
        null,
      );

      const out = await svc.changeStatusPending2('DI1');

      expect(out?.status).toBe(STATUS_DI.Pending2.status);
      expect(svc.diModel.updateOne).not.toHaveBeenCalled();
    });

    it('RETOUR + Fixtronix mais NON réparable → PENDING2 (le détour ne s’applique pas)', async () => {
      const svc = makeSvc(
        atMagasin({ can_be_repaired: false, isErrorFromFixtronix: true }),
        FIXTRONIX_LOG,
      );

      const out = await svc.changeStatusPending2('DI1');

      expect(out?.status).toBe(STATUS_DI.Pending2.status);
    });
  });

  describe('magasinTech_Pending2 (2e porte, mutation exposée)', () => {
    it('RETOUR + Fixtronix depuis MagasinEstimation → CONFIRMATION, aucune transition PENDING2', async () => {
      const svc = makeSvc(atMagasin({ isErrorFromFixtronix: true }), CLIENT_LOG);

      const out = await svc.magasinTech_Pending2('DI1');

      expect(out?.status).toBe(STATUS_DI.InMagasin.status);
      expect(svc.diWorkflowService.transition).not.toHaveBeenCalled();
      expect(svc.diModel.updateOne).toHaveBeenCalledWith(
        { _id: 'DI1' },
        { $set: { needsDevisBeforeRepair: true } },
      );
    });

    it('RETOUR + erreur CLIENT → transition MAGASIN_TECH_TO_PENDING2 (inchangé)', async () => {
      const svc = makeSvc(atMagasin(), CLIENT_LOG);

      await svc.magasinTech_Pending2('DI1');

      expect(svc.diWorkflowService.transition).toHaveBeenCalledWith(
        expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING2' }),
      );
    });

    it('sortie de DIAGNOSTIC (flux original, non réparable payant) → transition PENDING2 inchangée', async () => {
      const svc = makeSvc(
        atMagasin({
          status: STATUS_DI.InDiagnostic.status,
          ignoreCount: 0,
          can_be_repaired: false,
        }),
        null,
      );

      await svc.magasinTech_Pending2('DI1');

      expect(svc.diWorkflowService.transition).toHaveBeenCalledWith(
        expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING2' }),
      );
      expect(svc.diModel.updateOne).not.toHaveBeenCalled();
    });
  });
});

describe('Backstop « NON réparable » — changeStatusPending2', () => {
  it('sortie de diagnostic + NON réparable → IRREPARABLE (jamais PENDING2)', async () => {
    // C'est le chemin du bouton « Fin diagnostique retour » sur FT-06 / FT-09 :
    // il posait PENDING2 (facturation) sur une DI non réparable, d'où le grisage
    // du bouton côté UI. La garantie est désormais serveur.
    const svc = makeSvc(inDiagRetour({ can_be_repaired: false }), FIXTRONIX_LOG);

    const out = await svc.changeStatusPending2('DI1');

    expect(out?.status).toBe(STATUS_DI.Irreparable.status);
    expect(svc.closeIrreparable).toHaveBeenCalledWith('DI1');
    expect(svc.statsService.closeDiagLeg).toHaveBeenCalled();
    // N'écrit surtout pas PENDING2.
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('flux ORIGINAL + NON réparable → IRREPARABLE aussi (même garde)', async () => {
    const svc = makeSvc(
      inDiagRetour({ ignoreCount: 0, can_be_repaired: false }),
      null,
    );
    expect((await svc.changeStatusPending2('DI1'))?.status).toBe(
      STATUS_DI.Irreparable.status,
    );
  });

  it('RÉPARABLE → PENDING2 (non-régression)', async () => {
    const svc = makeSvc(inDiagRetour(), CLIENT_LOG);
    const out = await svc.changeStatusPending2('DI1');
    expect(out?.status).toBe(STATUS_DI.Pending2.status);
    expect(svc.closeIrreparable).not.toHaveBeenCalled();
  });
});

describe('changeStatusTofinsh — routage RETOUR complet (bouton « Envoyer vers finir »)', () => {
  it('RETOUR + réparable + AVEC PDR → magasin (et non IRREPARABLE)', async () => {
    const svc = makeRoutingSvc(
      inDiagRetour({ contain_pdr: true, array_composants: [{ x: 1 }] }),
      { can_be_repaired: true, contain_pdr: true, array_composants: [{ x: 1 }], isErrorFromFixtronix: true },
    );

    await svc.changeStatusTofinsh('DI1');

    expect(svc.changeStatusMagasinEstimation).toHaveBeenCalledWith('DI1');
    expect(svc.closeIrreparable).not.toHaveBeenCalled();
  });

  it('RETOUR + réparable + SANS PDR + Fixtronix → PENDING3', async () => {
    const svc = makeRoutingSvc(inDiagRetour({ isErrorFromFixtronix: true }), NO_PDR_LOG);
    await svc.changeStatusTofinsh('DI1');
    expect(svc.magasinTech_Pending3).toHaveBeenCalledWith('DI1');
    expect(svc.closeIrreparable).not.toHaveBeenCalled();
  });

  it('RETOUR + réparable + SANS PDR + erreur CLIENT → PENDING2 (et non IRREPARABLE)', async () => {
    const svc = makeRoutingSvc(inDiagRetour(), NO_PDR_LOG);
    await svc.changeStatusTofinsh('DI1');
    expect(svc.magasinTech_Pending2).toHaveBeenCalledWith('DI1');
    expect(svc.closeIrreparable).not.toHaveBeenCalled();
  });

  it('RETOUR + NON réparable → IRREPARABLE (inchangé)', async () => {
    const svc = makeRoutingSvc(inDiagRetour({ can_be_repaired: false }), {
      can_be_repaired: false, contain_pdr: false, array_composants: [], isErrorFromFixtronix: true,
    });
    await svc.changeStatusTofinsh('DI1');
    expect(svc.closeIrreparable).toHaveBeenCalledWith('DI1');
  });

  it('FLUX ORIGINAL + payant → PENDING2 (non-régression, branche intouchée)', async () => {
    const svc = makeRoutingSvc(
      inDiagRetour({ ignoreCount: 0, can_be_repaired: false, diagnosticPayant: true }),
      null,
    );
    await svc.changeStatusTofinsh('DI1');
    expect(svc.magasinTech_Pending2).toHaveBeenCalledWith('DI1');
    expect(svc.closeIrreparable).not.toHaveBeenCalled();
  });

  it('FLUX ORIGINAL + NON payant → IRREPARABLE (non-régression)', async () => {
    const svc = makeRoutingSvc(
      inDiagRetour({ ignoreCount: 0, can_be_repaired: false, diagnosticPayant: false }),
      null,
    );
    await svc.changeStatusTofinsh('DI1');
    expect(svc.closeIrreparable).toHaveBeenCalledWith('DI1');
  });
});
