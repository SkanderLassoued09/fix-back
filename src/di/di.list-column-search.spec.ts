// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';

/**
 * Filtres de colonnes des listes « Tickets » (`searchDi`) et « Coordination »
 * (`searchCoordinatorDI`), via `buildDiColumnSearchPredicates`.
 *
 * Avant : un seul filtre actif, saisie non échappée (`(` faisait lever Mongo),
 * rien sous 2 caractères, et une colonne jointe (société, client…) SANS
 * correspondance était ignorée — la liste ENTIÈRE revenait.
 */

const distinctOf = (ids: any[]) =>
  jest.fn(() => ({ distinct: jest.fn().mockResolvedValue(ids) }));

function makeSvc(
  lookups: {
    company?: any[];
    client?: any[];
    location?: any[];
    profile?: any[];
    statDi?: any[];
  } = {},
) {
  const captured: { find?: any; count?: any } = {};
  const chain: any = {
    populate: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    skip: jest.fn(() => chain),
    exec: jest.fn().mockResolvedValue([]),
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
  svc.companyModel = { find: distinctOf(lookups.company ?? []) };
  svc.clientModel = { find: distinctOf(lookups.client ?? []) };
  svc.locationModel = { find: distinctOf(lookups.location ?? []) };
  svc.profileModel = { find: distinctOf(lookups.profile ?? []) };
  svc.statModel = { find: distinctOf(lookups.statDi ?? []) };
  return { svc, captured };
}

const ALL = DiService.DI_LIST_SEARCH_FIELDS;
const rx = (source: string) => ({ $regex: source, $options: 'i' });

describe('DiService.buildDiColumnSearchPredicates', () => {
  it('cumule les colonnes directes, saisie échappée, dès 1 caractère', async () => {
    const { svc } = makeSvc();
    const preds = await svc.buildDiColumnSearchPredicates(
      [
        { field: '_idnum', value: 'T' },
        { field: 'title', value: ' a(b+ ' },
        { field: 'status', value: 'pending' },
      ],
      ALL,
    );
    expect(preds).toEqual([
      { _idnum: rx('T') },
      { title: rx('a\\(b\\+') },
      { status: rx('pending') },
    ]);
  });

  it('colonne jointe SANS correspondance → prédicat impossible (pas la liste entière)', async () => {
    const { svc } = makeSvc({ company: [] });
    const preds = await svc.buildDiColumnSearchPredicates(
      [{ field: 'company', value: 'inconnue' }],
      ALL,
    );
    expect(preds).toEqual([{ company_id: { $in: [] } }]);
  });

  it('colonnes jointes AVEC correspondance → $in des ids trouvés', async () => {
    const { svc } = makeSvc({
      company: ['CO1'],
      client: ['CL1', 'CL2'],
      location: ['L1'],
      profile: ['P1'],
    });
    const preds = await svc.buildDiColumnSearchPredicates(
      [
        { field: 'company', value: 'acme' },
        { field: 'client', value: 'ben' },
        { field: 'location', value: 'a1' },
        { field: 'createdBy', value: 'sam' },
      ],
      ALL,
    );
    expect(preds).toEqual([
      { company_id: { $in: ['CO1'] } },
      { client_id: { $in: ['CL1', 'CL2'] } },
      { location_id: { $in: ['L1'] } },
      { createdBy: { $in: ['P1'] } },
    ]);
  });

  it('tech sans profil trouvé → _id $in [] sans interroger les stats', async () => {
    const { svc } = makeSvc({ profile: [] });
    const preds = await svc.buildDiColumnSearchPredicates(
      [{ field: 'techDiag', value: 'personne' }],
      ALL,
    );
    expect(preds).toEqual([{ _id: { $in: [] } }]);
    expect(svc.statModel.find).not.toHaveBeenCalled();
  });

  it('techDiag + techRep se CUMULENT au lieu de s’écraser', async () => {
    const { svc } = makeSvc({ profile: ['P1'], statDi: ['DI1'] });
    const preds = await svc.buildDiColumnSearchPredicates(
      [
        { field: 'techDiag', value: 'ali' },
        { field: 'techRep', value: 'ali' },
      ],
      ALL,
    );
    expect(preds).toEqual([{ _id: { $in: ['DI1'] } }, { _id: { $in: ['DI1'] } }]);
    expect(svc.statModel.find).toHaveBeenCalledWith({
      id_tech_diag: { $in: ['P1'] },
    });
    expect(svc.statModel.find).toHaveBeenCalledWith({
      id_tech_rep: { $in: ['P1'] },
    });
  });

  it('ignore les champs hors liste blanche et les valeurs vides ; accepte un objet seul', async () => {
    const { svc } = makeSvc();
    expect(
      await svc.buildDiColumnSearchPredicates(
        [
          { field: 'isDeleted', value: 'true' },
          { field: 'title', value: '   ' },
        ],
        ALL,
      ),
    ).toEqual([]);
    expect(
      await svc.buildDiColumnSearchPredicates(
        { field: 'title', value: 'ecran' },
        ALL,
      ),
    ).toEqual([{ title: rx('ecran') }]);
    // Liste blanche restreinte (page magasin) : `company` ignoré.
    expect(
      await svc.buildDiColumnSearchPredicates(
        [{ field: 'company', value: 'acme' }],
        ['_idnum', 'title', 'status'],
      ),
    ).toEqual([]);
  });
});

describe.each([
  ['searchDi'],
  ['searchCoordinatorDI'],
])('DiService.%s — filtres de colonnes', (method) => {
  it('pose les prédicats cumulés dans $and, base isDeleted:false intacte', async () => {
    const { svc, captured } = makeSvc({ company: [] });
    await svc[method]({ first: 0, rows: 10 }, [
      { field: 'title', value: 'ecran' },
      { field: 'company', value: 'inconnue' },
    ]);
    expect(captured.find).toEqual({
      isDeleted: false,
      $and: [{ title: rx('ecran') }, { company_id: { $in: [] } }],
    });
    // Même filtre pour le compteur et pour la page.
    expect(captured.count).toBe(captured.find);
  });

  it('sans filtre exploitable → liste de base, pas de $and', async () => {
    const { svc, captured } = makeSvc();
    await svc[method]({ first: 0, rows: 10 }, [{ field: 'title', value: '' }]);
    expect(captured.find).toEqual({ isDeleted: false });
  });
});
