// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { STATUS_DI } from './di.status';

/**
 * Réactivation d'une DI annulée → statut précédent (feat/di-annulation-retour).
 * L'annulation étant NON destructrice, le retour se lit dans `statusHistory`.
 * Gardes server-authoritative : non annulée / sans statut précédent / origine
 * POST-DOCUMENT (BL·facture émis) / déjà réactivée une fois (1 max).
 */

function makeSvc(di: any) {
  const svc: any = Object.create(DiService.prototype);
  svc.diModel = {
    findOne: jest.fn().mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(di) }),
    }),
    findOneAndUpdate: jest.fn().mockImplementation((filter: any, update: any) =>
      Promise.resolve({
        _id: filter._id,
        ...di,
        status: update.$set.status,
        current_roles: update.$set.current_roles,
      }),
    ),
  };
  svc.auditService = { create: jest.fn().mockResolvedValue({}) };
  svc.operationalErrorService = { capture: jest.fn().mockResolvedValue({}) };
  svc.notificationGateway = { updateTicket: jest.fn() };
  return svc;
}

/** Build a statusHistory array from status values. */
const H = (...statuses: string[]) =>
  statuses.map((s) => ({ status: s, at: new Date() }));

describe('DiService.reactiverDi', () => {
  it('ANNULER + historique → réactive au statut précédent, efface les métadonnées, trace Audit', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      status: STATUS_DI.Annuler.status,
      statusHistory: H('PENDING1', 'DIAGNOSTIC', 'PENDING2', 'WAITING_BC', 'ANNULER'),
      annulePar: 'someone',
    });

    await svc.reactiverDi('DI1', { username: 'coord' });

    const [filter, update] = svc.diModel.findOneAndUpdate.mock.calls[0];
    // Écriture GARDÉE sur l'état ANNULER (anti-course).
    expect(filter).toEqual({ _id: 'DI1', status: STATUS_DI.Annuler.status });
    // Ramenée au statut PRÉCÉDENT.
    expect(update.$set.status).toBe('WAITING_BC');
    // current_roles re-dérivé du statut cible (WaitingBc.role = ['Manager']).
    expect(update.$set.current_roles).toEqual(STATUS_DI.WaitingBc.role);
    // Métadonnées d'annulation effacées.
    expect(update.$set.annulePar).toBeNull();
    expect(update.$set.annuleLe).toBeNull();
    expect(update.$set.annulationMotif).toBeNull();
    expect(update.$set.annulationCommentaire).toBeNull();
    expect(update.$set.annulationParClient).toBeNull();
    // Audit (auteur dans le message, faute de champ dédié).
    expect(svc.auditService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        _idDoc: 'DI1',
        type: 'DI_REACTIVATED',
        message: expect.stringContaining('coord'),
      }),
    );
  });

  it('DI non annulée → refus, aucune écriture', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      status: STATUS_DI.Pending2.status,
      statusHistory: H('PENDING2'),
    });
    await expect(svc.reactiverDi('DI1', { username: 'c' })).rejects.toThrow(
      /pas annulée/,
    );
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('statut précédent introuvable (ANNULER en tête d’historique) → refus', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      status: STATUS_DI.Annuler.status,
      statusHistory: H('ANNULER'),
    });
    await expect(svc.reactiverDi('DI1', { username: 'c' })).rejects.toThrow(
      /introuvable/,
    );
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('origine POST-DOCUMENT (WAITING_FACTURE) → refus (prudence comptable)', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      status: STATUS_DI.Annuler.status,
      statusHistory: H('WAITING_BL', 'WAITING_FACTURE', 'ANNULER'),
    });
    await expect(svc.reactiverDi('DI1', { username: 'c' })).rejects.toThrow(
      /interdite|BL\/facture/,
    );
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('origine FINISHED → refus', async () => {
    const svc = makeSvc({
      _id: 'DI1',
      status: STATUS_DI.Annuler.status,
      statusHistory: H('WAITING_FACTURE', 'FINISHED', 'ANNULER'),
    });
    await expect(svc.reactiverDi('DI1', { username: 'c' })).rejects.toThrow(
      /interdite/,
    );
  });

  it('déjà réactivée une fois → refus (1 max)', async () => {
    // ANNULER(idx1) suivi de WAITING_BC(idx2) = une réactivation PASSÉE ; puis
    // ré-annulée (dernier ANNULER, idx3). Le statut précédent (WAITING_BC) est OK
    // mais l'anti-boucle refuse une 2ᵉ réactivation.
    const svc = makeSvc({
      _id: 'DI1',
      status: STATUS_DI.Annuler.status,
      statusHistory: H('PENDING2', 'ANNULER', 'WAITING_BC', 'ANNULER'),
    });
    await expect(svc.reactiverDi('DI1', { username: 'c' })).rejects.toThrow(
      /déjà.*réactivée/,
    );
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
