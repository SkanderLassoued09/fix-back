// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { STATUS_DI } from './di.status';
import { DI_TRANSITIONS } from './workflow/di-transition.map';
import { ALLOWED_TRANSITIONS } from './workflow/di-transition-guard';

/**
 * Raccourci RETOUR sans PDR (erreur Fixtronix) → PENDING3.
 *
 * Règle métier (tranchée avec le PO) : en phase RETOUR, si le diagnostic conclut
 * « aucune pièce » ET que la faute est une erreur Fixtronix, la DI saute le
 * magasin ET la tarification (non facturé) et file directement en PENDING3, où
 * la COORDINATRICE l'envoie en réparation en joignant le devis (traçabilité).
 *
 * Points durs vérifiés ici :
 *   - le raccourci lit le SNAPSHOT DU CYCLE (LogsDi), pas la DI live (périmée
 *     en retour) ;
 *   - il ne s'active QUE pour retour + sans PDR + erreur Fixtronix ; toute autre
 *     combinaison retombe sur le routage existant (PENDING2 / MagasinEstimation) ;
 *   - une DI HORS retour ne peut PAS sauter la tarification (garde ignoreCount) ;
 *   - la transition PENDING3 depuis le diagnostic est DÉDIÉE et `strictFrom` — la
 *     whitelist générique n'ouvre AUCUN INDIAGNOSTIC → PENDING3 pour les autres
 *     mutations.
 */

function makeRouterSvc(di: any, cycleLog: any) {
  const svc: any = Object.create(DiService.prototype);
  svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
  svc.diModel = {
    findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(di) }),
    findOneAndUpdate: jest.fn().mockResolvedValue({
      ...di,
      status: STATUS_DI.MagasinEstimation.status,
      ignoreCount: di.ignoreCount ?? 0,
    }),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
  svc.diWorkflowService = {
    transition: jest.fn().mockImplementation((input: any) =>
      Promise.resolve({
        di: { ...di, _idnum: 'T1', status: STATUS_DI.Pending3.status },
        transitionKey: input.transitionKey,
      }),
    ),
  };
  svc.statsService = {
    updateStatus: jest.fn().mockResolvedValue(undefined),
    closeDiagLeg: jest.fn().mockResolvedValue(null),
    openDiagLeg: jest.fn().mockResolvedValue(true),
  };
  svc.logsDiService = {
    getLogsById: jest.fn().mockResolvedValue(cycleLog),
  };
  svc.discordHookService = {
    sendDiagnosticFinished: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationGateway = { updateTicket: jest.fn() };
  svc.notificationService = { emit: jest.fn().mockResolvedValue({}) };
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

describe('DiService.changeStatusMagasinEstimation — raccourci RETOUR sans PDR (Fixtronix)', () => {
  it('RETOUR + sans PDR (cycle) + erreur Fixtronix → PENDING3 (magasin ET tarif sautés)', async () => {
    const svc = makeRouterSvc(
      // DI live : contain_pdr PÉRIMÉ (cycle 0), doit être IGNORÉ au profit du log.
      { _id: 'DI1', ignoreCount: 1, contain_pdr: true, array_composants: [{ x: 1 }] },
      // Snapshot du cycle retour : réparable, aucune pièce + erreur Fixtronix.
      // `can_be_repaired` est OBLIGATOIRE : sans verdict réparable sur le cycle,
      // le routage clôture en IRREPARABLE avant d'atteindre le raccourci.
      {
        can_be_repaired: true,
        contain_pdr: false,
        array_composants: [],
        isErrorFromFixtronix: true,
      },
    );

    await svc.changeStatusMagasinEstimation('DI1');

    // Lecture cycle-correcte (LogsDi du cycle courant), pas la DI live.
    expect(svc.logsDiService.getLogsById).toHaveBeenCalledWith(1, 'DI1');
    // Transition DÉDIÉE → PENDING3 (pas PENDING2, pas MagasinEstimation).
    expect(svc.diWorkflowService.transition).toHaveBeenCalledWith(
      expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING3' }),
    );
    // Marqueur « devis attendu de la coordinatrice » posé.
    expect(svc.diModel.updateOne).toHaveBeenCalledWith(
      { _id: 'DI1' },
      { $set: { needsDevisBeforeRepair: true } },
    );
    // N'écrit PAS MagasinEstimation.
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('RETOUR + sans PDR (cycle) MAIS PAS erreur Fixtronix → routage existant (PENDING2), pas PENDING3', async () => {
    const svc = makeRouterSvc(
      { _id: 'DI1', ignoreCount: 1, contain_pdr: false, array_composants: [] },
      {
        can_be_repaired: true,
        contain_pdr: false,
        array_composants: [],
        isErrorFromFixtronix: false,
      },
    );

    await svc.changeStatusMagasinEstimation('DI1');

    // Pas de PENDING3 : on retombe sur la route no-PDR → PENDING2 (inchangée).
    expect(svc.diWorkflowService.transition).toHaveBeenCalledWith(
      expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING2' }),
    );
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING3' }),
    );
    expect(svc.diModel.updateOne).not.toHaveBeenCalled();
  });

  it('RETOUR + AVEC PDR (cycle) même si Fixtronix → PAS de raccourci (routage existant)', async () => {
    const svc = makeRouterSvc(
      { _id: 'DI1', ignoreCount: 2, contain_pdr: true, array_composants: [{ x: 1 }] },
      {
        can_be_repaired: true,
        contain_pdr: true,
        array_composants: [{ nameComposant: 'Fusible', quantity: 1 }],
        isErrorFromFixtronix: true,
      },
    );

    await svc.changeStatusMagasinEstimation('DI1');

    // Avec PDR → jamais PENDING3 par ce raccourci.
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING3' }),
    );
  });

  it('HORS retour (ignoreCount=0) + sans PDR → PENDING2, JAMAIS PENDING3 (pas de saut de tarif hors retour)', async () => {
    const svc = makeRouterSvc(
      // Même une DI marquée Fixtronix sur la live, mais ignoreCount=0 : interdit.
      { _id: 'DI1', ignoreCount: 0, contain_pdr: false, array_composants: [], isErrorFromFixtronix: true },
      null,
    );

    await svc.changeStatusMagasinEstimation('DI1');

    // cycle=0 → le snapshot n'est même pas lu, et pas de PENDING3.
    expect(svc.logsDiService.getLogsById).not.toHaveBeenCalled();
    expect(svc.diWorkflowService.transition).toHaveBeenCalledWith(
      expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING2' }),
    );
    expect(svc.diWorkflowService.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ transitionKey: 'MAGASIN_TECH_TO_PENDING3' }),
    );
  });
});

describe('coordinatorSendToRepairWithDevis — devis BLOQUANT + orchestration', () => {
  function makeSendSvc() {
    const svc: any = Object.create(DiService.prototype);
    svc.addDevisPDF = jest.fn().mockResolvedValue({ _id: 'DI1' });
    svc.statsService = { affectForRep: jest.fn().mockResolvedValue(undefined) };
    svc.diModel = { updateOne: jest.fn().mockResolvedValue({ acknowledged: true }) };
    svc.changeStatusRepaire = jest
      .fn()
      .mockResolvedValue({ _id: 'DI1', status: STATUS_DI.Reparation.status });
    return svc;
  }

  it('sans devis → REFUS (BAD_REQUEST), aucun effet de bord', async () => {
    const svc = makeSendSvc();
    await expect(
      svc.coordinatorSendToRepairWithDevis('DI1', 'TECH1', ''),
    ).rejects.toThrow(/Devis obligatoire/);
    expect(svc.addDevisPDF).not.toHaveBeenCalled();
    expect(svc.statsService.affectForRep).not.toHaveBeenCalled();
    expect(svc.changeStatusRepaire).not.toHaveBeenCalled();
  });

  it('sans technicien → REFUS (BAD_REQUEST)', async () => {
    const svc = makeSendSvc();
    await expect(
      svc.coordinatorSendToRepairWithDevis('DI1', '', 'data:application/pdf;base64,AAAA'),
    ).rejects.toThrow(/Technicien réparateur obligatoire/);
    expect(svc.addDevisPDF).not.toHaveBeenCalled();
  });

  it('happy path → devis joint, tech affecté, marqueur retiré, PENDING3 → REPARATION', async () => {
    const svc = makeSendSvc();
    await svc.coordinatorSendToRepairWithDevis(
      'DI1',
      'TECH1',
      'data:application/pdf;base64,AAAA',
    );

    expect(svc.addDevisPDF).toHaveBeenCalledWith(
      'DI1',
      'data:application/pdf;base64,AAAA',
    );
    expect(svc.statsService.affectForRep).toHaveBeenCalledWith('DI1', 'TECH1');
    // Le marqueur d'attente de devis est retiré avant la transition.
    expect(svc.diModel.updateOne).toHaveBeenCalledWith(
      { _id: 'DI1' },
      { $set: { needsDevisBeforeRepair: false } },
    );
    expect(svc.changeStatusRepaire).toHaveBeenCalledWith('DI1');
  });
});

describe('Garde-fou transitions : PENDING3 depuis le diagnostic reste FERMÉ hors raccourci', () => {
  it('MAGASIN_TECH_TO_PENDING3 est une transition DÉDIÉE, strictFrom, INDIAGNOSTIC/_Pause → PENDING3', () => {
    const t = (DI_TRANSITIONS as any).MAGASIN_TECH_TO_PENDING3;
    expect(t).toBeDefined();
    expect(t.strictFrom).toBe(true);
    expect(t.to).toBe(STATUS_DI.Pending3.status);
    expect(t.from).toEqual(
      expect.arrayContaining([
        STATUS_DI.InDiagnostic.status,
        STATUS_DI.DiagnosticInPause.status,
      ]),
    );
    // Ne part JAMAIS d'une source hors diagnostic.
    expect(t.from).not.toContain(STATUS_DI.InMagasin.status);
    expect(t.from).not.toContain(STATUS_DI.WaitingBc.status);
  });

  it('la whitelist générique ALLOWED_TRANSITIONS[PENDING3] n’inclut PAS le diagnostic', () => {
    const sources = ALLOWED_TRANSITIONS[STATUS_DI.Pending3.status];
    // Sinon changeStatusPending3 (et tout appelant d'assertDiTransition) pourrait
    // sauter la tarification hors retour → ce qu'on interdit.
    expect(sources).not.toContain(STATUS_DI.InDiagnostic.status);
    expect(sources).not.toContain(STATUS_DI.DiagnosticInPause.status);
  });
});
