import { StatService } from './stat.service';

/**
 * Le Tech ne voit JAMAIS la clôture documentaire : `getDiStatusCounts` (tuiles
 * du dashboard + mini-dashboard de la liste technicien) exclut WAITING_BL,
 * WAITING_FACTURE et leurs valeurs legacy, comme la liste le fait déjà.
 */
describe('StatService.getDiStatusCounts · clôture masquée au Tech', () => {
  it('exclut WAITING_BL / WAITING_FACTURE (+ legacy) du $match', async () => {
    const svc: any = Object.create(StatService.prototype);
    svc.StatModel = { aggregate: jest.fn().mockResolvedValue([]) };

    await svc.getDiStatusCounts('TECH1');

    const [pipeline] = svc.StatModel.aggregate.mock.calls[0];
    const clauses = pipeline[0].$match.$and;
    const statusClause = clauses.find((c: any) => c?.status?.$nin);
    expect(statusClause.status.$nin).toEqual(
      expect.arrayContaining([
        'WAITING_BL',
        'WAITING_FACTURE',
        'CLOSING',
        'ATTENTE_BL_FACTURE',
      ]),
    );
    // Toujours limité aux DI du technicien.
    expect(clauses).toContainEqual({
      $or: [{ id_tech_diag: 'TECH1' }, { id_tech_rep: 'TECH1' }],
    });
  });
});
