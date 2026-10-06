import { syncStatStatusFromDis } from './entities/di.entity';

// Invariant Di.status → Stat.status du cycle courant (cf. di.entity.ts).
describe('syncStatStatusFromDis', () => {
  const makeDiModel = (dis: any[], Stat: any) => ({
    db: { models: { Stat } },
    find: () => ({ select: () => ({ lean: async () => dis }) }),
  });

  it('copies the DI status onto the current-cycle stat only', async () => {
    const Stat = { bulkWrite: jest.fn() };
    await syncStatStatusFromDis(
      makeDiModel(
        [
          { _id: 'a', status: 'ANNULER', ignoreCount: 0 },
          { _id: 'b', status: 'FINISHED', ignoreCount: 2 },
        ],
        Stat,
      ),
      ['a', 'b'],
    );
    expect(Stat.bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateMany: {
            filter: { _idDi: 'a', ignoreCount: { $in: [0, null] } },
            update: { $set: { status: 'ANNULER' } },
          },
        },
        {
          updateMany: {
            filter: { _idDi: 'b', ignoreCount: 2 },
            update: { $set: { status: 'FINISHED' } },
          },
        },
      ],
      { ordered: false },
    );
  });

  it('is a no-op when the Stat model is not registered', async () => {
    await expect(
      syncStatStatusFromDis({ db: { models: {} } }, ['a']),
    ).resolves.toBeUndefined();
  });
});
