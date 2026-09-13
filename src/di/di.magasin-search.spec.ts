// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { MAGASIN_STATUS_DI_VALUES } from './di.status';

/**
 * Filtres de colonnes de la page « Magasin / Composants ».
 *
 * Avant : l'ID n'était jamais filtré (le back n'acceptait que title/status et
 * renvoyait la liste ENTIÈRE en silence), rien sous 2 caractères, saisie non
 * échappée (`(` faisait lever Mongo) et un seul filtre actif à la fois.
 */

function makeSvc() {
  const captured: { count?: any; find?: any } = {};
  const exec = jest.fn().mockResolvedValue([]);
  const chain = {
    sort: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    skip: jest.fn(() => chain),
    exec,
  };
  const svc: any = Object.create(DiService.prototype);
  svc.diModel = {
    countDocuments: jest.fn((f) => {
      captured.count = f;
      return Promise.resolve(0);
    }),
    find: jest.fn((f) => {
      captured.find = f;
      return chain;
    }),
  };
  return { svc, captured };
}

const PAGE = { first: 0, rows: 10 };

const expectBaseFilterUntouched = (filter: any) => {
  expect(filter.contain_pdr).toBe(true);
  expect(filter.isDeleted).toBe(false);
  expect(filter.status).toEqual({ $in: MAGASIN_STATUS_DI_VALUES });
};

describe('DiService.searchDiForMagasin — filtres de colonnes', () => {
  it('filtre sur l’ID affiché (_idnum)', async () => {
    const { svc, captured } = makeSvc();
    await svc.searchDiForMagasin(PAGE, [{ field: '_idnum', value: 'T12' }]);
    expect(captured.find.$and).toEqual([
      { _idnum: { $regex: 'T12', $options: 'i' } },
    ]);
    expectBaseFilterUntouched(captured.find);
    // Même filtre pour le compteur et pour la page.
    expect(captured.count).toBe(captured.find);
  });

  it('applique une saisie d’un seul caractère', async () => {
    const { svc, captured } = makeSvc();
    await svc.searchDiForMagasin(PAGE, [{ field: 'title', value: 'a' }]);
    expect(captured.find.$and).toEqual([
      { title: { $regex: 'a', $options: 'i' } },
    ]);
  });

  it('échappe les caractères spéciaux de regex', async () => {
    const { svc, captured } = makeSvc();
    await svc.searchDiForMagasin(PAGE, [{ field: 'title', value: ' a(b+ ' }]);
    expect(captured.find.$and).toEqual([
      { title: { $regex: 'a\\(b\\+', $options: 'i' } },
    ]);
  });

  it('cumule plusieurs colonnes sans toucher au filtre de base', async () => {
    const { svc, captured } = makeSvc();
    await svc.searchDiForMagasin(PAGE, [
      { field: 'title', value: 'ecran' },
      { field: 'status', value: 'estimation' },
    ]);
    expect(captured.find.$and).toEqual([
      { title: { $regex: 'ecran', $options: 'i' } },
      { status: { $regex: 'estimation', $options: 'i' } },
    ]);
    expectBaseFilterUntouched(captured.find);
  });

  it('ignore un champ hors liste blanche et les valeurs vides', async () => {
    const { svc, captured } = makeSvc();
    await svc.searchDiForMagasin(PAGE, [
      { field: 'contain_pdr', value: 'false' },
      { field: 'title', value: '   ' },
    ]);
    expect(captured.find.$and).toBeUndefined();
    expectBaseFilterUntouched(captured.find);
  });

  it('accepte encore un objet de recherche seul (ancien appel)', async () => {
    const { svc, captured } = makeSvc();
    await svc.searchDiForMagasin(PAGE, { field: 'title', value: 'ecran' });
    expect(captured.find.$and).toEqual([
      { title: { $regex: 'ecran', $options: 'i' } },
    ]);
  });
});
