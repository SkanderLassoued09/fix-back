import { TechAnalyticsService } from './tech-analytics.service';

/**
 * Leaderboard technicien — non-régression du plantage
 * « can't $subtract date from string » remonté en production.
 *
 * Une SEULE DI dont `updatedAt` est une chaîne (document hérité / édité à la
 * main) faisait tomber l'agrégation entière, donc tout le tableau, en 500. Deux
 * garanties sont verrouillées ici : le pipeline ne peut plus recevoir de valeur
 * non convertie, et la moyenne se divise par le nombre d'échantillons réellement
 * mesurés — pas par le nombre de DI clôturées.
 */
function makeSvc(rows: any[]) {
  const svc: any = Object.create(TechAnalyticsService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.statModel = { aggregate: jest.fn().mockResolvedValue(rows) };
  return svc;
}

const row = (over: Record<string, any> = {}) => ({
  techId: 'T1',
  profile: { firstName: 'Ada', lastName: 'L', role: 'TECH' },
  nbDiTraites: 10,
  nbDiClotures: 4,
  nbFinishedFtr: 3,
  nbRetours: 1,
  nbIrreparables: 0,
  nbTatSamples: 4,
  totalTatMs: 4 * 24 * 3600 * 1000, // 4 DI × 1 jour
  ...over,
});

describe('TechAnalyticsService.getTechLeaderboard', () => {
  it('divise le TAT par les échantillons MESURÉS, pas par les DI clôturées', async () => {
    // 4 DI clôturées mais une seule date exploitable : la moyenne doit valoir
    // 1 jour, pas 0,25. Diviser par `nbDiClotures` sous-évaluerait le TAT en
    // silence — plus grave qu'un plantage, parce qu'invisible.
    const svc = makeSvc([
      row({ nbDiClotures: 4, nbTatSamples: 1, totalTatMs: 24 * 3600 * 1000 }),
    ]);

    const [r] = await svc.getTechLeaderboard();

    expect(r.tatMoyenJours).toBeCloseTo(1, 6);
  });

  it('aucune date exploitable ⇒ 0, jamais NaN ni Infinity', async () => {
    const svc = makeSvc([row({ nbTatSamples: 0, totalTatMs: 0 })]);

    const [r] = await svc.getTechLeaderboard();

    expect(r.tatMoyenJours).toBe(0);
    expect(Number.isFinite(r.tatMoyenJours)).toBe(true);
  });

  it('convertit les bornes de date au lieu de les projeter brutes', async () => {
    const svc = makeSvc([row()]);
    await svc.getTechLeaderboard();

    const [pipeline] = svc.statModel.aggregate.mock.calls[0];
    const projections = pipeline.filter((st: any) => st.$project);
    const withDates = projections.find((st: any) => st.$project.updatedAt);

    // C'EST la garde anti-plantage : sans `onError`, une chaîne interrompt
    // toute l'agrégation.
    expect(withDates.$project.updatedAt.$convert).toMatchObject({
      to: 'date',
      onError: null,
    });
    expect(withDates.$project.createdAt.$convert).toMatchObject({
      to: 'date',
      onError: null,
    });
  });

  it('le compteur et la somme du TAT partagent la MÊME condition', async () => {
    const svc = makeSvc([row()]);
    await svc.getTechLeaderboard();

    const [pipeline] = svc.statModel.aggregate.mock.calls[0];
    const grp = pipeline.find((st: any) => st.$group?.nbTatSamples).$group;

    // S'ils divergent, la moyenne est fausse sans que rien ne le signale.
    expect(grp.nbTatSamples.$sum.$cond[0]).toEqual(grp.totalTatMs.$sum.$cond[0]);
  });

  it('une date d’entrée invalide ne part pas au driver', async () => {
    const svc = makeSvc([row()]);
    await svc.getTechLeaderboard('n’importe quoi', 'pas une date');

    const [pipeline] = svc.statModel.aggregate.mock.calls[0];
    // `new Date('n’importe quoi')` donnerait `Invalid Date`, rejeté au niveau
    // BSON — même classe de plantage, autre porte d'entrée.
    expect(pipeline[0].$match).toEqual({});
  });

  it('borne `limit` des deux côtés', async () => {
    const svc = makeSvc([row()]);

    await svc.getTechLeaderboard(undefined, undefined, 0);
    let [pipeline] = svc.statModel.aggregate.mock.calls[0];
    expect(pipeline.find((st: any) => st.$limit).$limit).toBe(1);

    await svc.getTechLeaderboard(undefined, undefined, 5000);
    [pipeline] = svc.statModel.aggregate.mock.calls[1];
    expect(pipeline.find((st: any) => st.$limit).$limit).toBe(100);
  });
});
