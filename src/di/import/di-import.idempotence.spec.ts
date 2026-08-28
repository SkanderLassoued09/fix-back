// nanoid ESM → mock.
let nanoidCalls = 0;
jest.mock('nanoid', () => ({ nanoid: () => `id${++nanoidCalls}` }));

import { DiImportService } from './di-import.service';
import { DiImportJobService } from './di-import-job.service';

/**
 * Étape 5 — IDEMPOTENCE & REPRISE (partial progress + safe retry, sans nouvelle
 * infra). Harness à ÉTAT RÉEL : un `refStore` (Set) mime l'unicité `_idnum` — un
 * `createDi(forcedRef)` sur une réf DÉJÀ présente lève `E11000` (comme l'index
 * unique), exactement comme en base. On PROUVE qu'aucune combinaison ne crée
 * deux DI de même `_idnum`.
 */
function makeJobModel() {
  const store = new Map<string, any>();
  return {
    create: jest.fn(async (doc: any) => {
      const d = { ...doc, createdAt: new Date(), updatedAt: new Date() };
      store.set(doc.jobId, d);
      return d;
    }),
    findOne: jest.fn((q: any) => ({ lean: async () => store.get(q.jobId) ?? null })),
    find: jest.fn(() => ({ sort: () => ({ lean: async () => [...store.values()] }) })),
    findOneAndUpdate: jest.fn(async (q: any, upd: any) => {
      const d = store.get(q.jobId);
      if (!d) return null;
      if (upd.$set) Object.assign(d, upd.$set);
      if (upd.$inc) for (const k of Object.keys(upd.$inc)) d[k] = (d[k] ?? 0) + upd.$inc[k];
      return d;
    }),
  };
}
const findReturning = (rows: any[]) => ({
  find: jest.fn().mockReturnValue({ lean: async () => rows }),
});

/** `refStore` PARTAGÉ = état des `_idnum` déjà persistés. `createDi(forcedRef)`
 *  est ATOMIQUE (has→add sans await intermédiaire) → mime l'index unique. */
function makeHarness() {
  const refStore = new Set<string>();
  const svc: any = Object.create(DiImportService.prototype);
  svc.jobService = new DiImportJobService(makeJobModel() as any);
  svc.diService = {
    createDi: jest.fn(async (_input: any, opts: any) => {
      const ref = opts?.forcedRef;
      if (ref && refStore.has(ref)) {
        throw Object.assign(new Error(`E11000 duplicate key: _idnum ${ref}`), {
          code: 11000,
        });
      }
      if (ref) refStore.add(ref); // check-then-add synchrone → atomique
      return { _id: 'DI_' + ref };
    }),
  };
  svc.notificationGateway = { diImportProgress: jest.fn() };
  svc.logger = { warn: jest.fn(), error: jest.fn() };
  svc.clientsService = { createClient: jest.fn(async (i: any) => ({ _id: 'C1', ...i })) };
  svc.locationService = { createlocation: jest.fn(async (i: any) => ({ _id: 'L1', ...i })) };
  svc.locationModel = findReturning([]);
  svc.aliasService = {
    getAliasMap: jest.fn().mockResolvedValue(new Map()),
    isValid: jest.fn().mockReturnValue(false),
    record: jest.fn(),
  };
  return { svc, refStore };
}

function pr(n: number, name = 'ACME') {
  const nDi = `T${n}`;
  return {
    ligne: n,
    nDi,
    designation: 'D' + n,
    nSerie: '***',
    clientName: name,
    rangement: '',
    dateValue: null,
    raw: { 'N° DI': nDi, Client: name },
  };
}
const ctx = () => ({ clientCache: new Map(), companyCache: new Map(), createdBy: 'U1' });

beforeEach(() => (nanoidCalls = 0));

describe('Idempotence — même lot rejoué', () => {
  it('rejouer le MÊME lot ne crée aucun doublon (E11000 → ignoré)', async () => {
    const { svc, refStore } = makeHarness();
    const rows = [pr(100), pr(101), pr(102)];

    const j1 = await svc.jobService.create({ createdBy: 'U1', total: 3 });
    await svc.processJob(j1.jobId, rows, ctx());
    expect((await svc.jobService.getById(j1.jobId)).report.crees.dis).toBe(3);
    expect(refStore.size).toBe(3);

    const j2 = await svc.jobService.create({ createdBy: 'U1', total: 3 });
    await svc.processJob(j2.jobId, rows, ctx());
    const r2 = await svc.jobService.getById(j2.jobId);
    expect(r2.report.crees.dis).toBe(0); // rien de nouveau
    expect(r2.report.crees.ignorees).toBe(3); // 3 déjà existantes → ignorées
    expect(r2.report.erreurs).toHaveLength(0); // pas des erreurs
    expect(refStore.size).toBe(3); // toujours 3 DI, pas 6
  });
});

describe('Idempotence — crash à mi-parcours puis reprise', () => {
  it('25 créées avant crash → reprise : 25 conservées, 15 restantes créées, 0 doublon', async () => {
    const { svc, refStore } = makeHarness();
    const rows = Array.from({ length: 40 }, (_, i) => pr(300 + i));

    // 1er run : crash juste après le 1er lot (incrementProgress rejette).
    const crashingJob = {
      markRunning: jest.fn(async () => ({})),
      incrementProgress: jest.fn(async () => {
        throw new Error('crash serveur');
      }),
      complete: jest.fn(async () => ({})),
      fail: jest.fn(async () => ({})),
    };
    svc.jobService = crashingJob;
    await svc.processJob('J1', rows, ctx());
    expect(refStore.size).toBe(25); // 1er lot (BATCH_SIZE) persisté avant le crash
    expect(crashingJob.fail).toHaveBeenCalledTimes(1); // FAILED
    expect(crashingJob.complete).not.toHaveBeenCalled();

    // Reprise : nouveau job réel, MÊME lot.
    svc.jobService = new DiImportJobService(makeJobModel() as any);
    const j2 = await svc.jobService.create({ createdBy: 'U1', total: 40 });
    await svc.processJob(j2.jobId, rows, ctx());
    const r2 = await svc.jobService.getById(j2.jobId);
    expect(r2.status).toBe('COMPLETED');
    expect(r2.report.crees.dis).toBe(15); // les 15 restantes
    expect(r2.report.crees.ignorees).toBe(25); // les 25 déjà là
    expect(refStore.size).toBe(40); // total, JAMAIS 65
  });
});

describe('Idempotence — concurrence sur la même référence', () => {
  it('deux jobs sur T200 en parallèle → une seule DI, l’autre E11000 → ignoré', async () => {
    const { svc, refStore } = makeHarness();
    const jA = await svc.jobService.create({ createdBy: 'U1', total: 1 });
    const jB = await svc.jobService.create({ createdBy: 'U2', total: 1 });

    await Promise.all([
      svc.processJob(jA.jobId, [pr(200)], ctx()),
      svc.processJob(jB.jobId, [pr(200)], ctx()),
    ]);

    const rA = await svc.jobService.getById(jA.jobId);
    const rB = await svc.jobService.getById(jB.jobId);
    expect(refStore.size).toBe(1); // une seule DI T200
    expect(rA.report.crees.dis + rB.report.crees.dis).toBe(1); // 1 création
    expect(rA.report.crees.ignorees + rB.report.crees.ignorees).toBe(1); // l'autre ignoré
    expect(rA.report.erreurs.length + rB.report.erreurs.length).toBe(0); // pas d'erreur
  });
});

describe('Ré-import après suppression (soft-delete)', () => {
  it('réf d’une DI SUPPRIMÉE → vestige purgé puis RECRÉÉE (pas « existe déjà »)', async () => {
    const { svc, refStore } = makeHarness();
    // `refStore` mime l'index unique : T500 est "occupée" par une DI SUPPRIMÉE.
    // `freeDeletedRef` doit la purger (libérer l'index) puis `createDi` recrée.
    refStore.add('T500');
    svc.diModel = {
      deleteOne: jest.fn(async (q: any) => {
        if (q?._idnum && q?.isDeleted === true && refStore.has(q._idnum)) {
          refStore.delete(q._idnum); // purge → l'index unique est libéré
          return { deletedCount: 1 };
        }
        return { deletedCount: 0 };
      }),
    };

    const j = await svc.jobService.create({ createdBy: 'U1', total: 1 });
    await svc.processJob(j.jobId, [pr(500)], {
      ...ctx(),
      deletedRefs: new Set(['T500']), // T500 = réf d'une DI supprimée
    });
    const r = await svc.jobService.getById(j.jobId);

    expect(svc.diModel.deleteOne).toHaveBeenCalledWith({
      _idnum: 'T500',
      isDeleted: true,
    });
    expect(r.report.crees.dis).toBe(1); // RECRÉÉE (et non « ignorée »)
    expect(r.report.crees.reactivees).toBe(1);
    expect(r.report.crees.ignorees).toBe(0);
    expect(r.report.erreurs).toHaveLength(0);
    expect(refStore.has('T500')).toBe(true); // l'index reporte T500 (recréée)
  });

  it('réf d’une DI ACTIVE → reste BLOQUÉE (idempotence), aucune purge', async () => {
    const { svc, refStore } = makeHarness();
    refStore.add('T501'); // DI ACTIVE (non supprimée)
    svc.diModel = { deleteOne: jest.fn(async () => ({ deletedCount: 0 })) };
    const j = await svc.jobService.create({ createdBy: 'U1', total: 1 });
    // T501 n'est PAS dans deletedRefs (active) → pas de purge → E11000 → ignorée.
    await svc.processJob(j.jobId, [pr(501)], { ...ctx(), deletedRefs: new Set() });
    const r = await svc.jobService.getById(j.jobId);

    expect(svc.diModel.deleteOne).not.toHaveBeenCalled();
    expect(r.report.crees.dis).toBe(0);
    expect(r.report.crees.ignorees).toBe(1);
    expect(r.report.crees.reactivees).toBe(0);
  });
});

describe('Idempotence — erreur individuelle & continuation', () => {
  it('T100 ok, T101 erreur (non-duplicate), T102 ok → created=2, errors=1, job COMPLETED', async () => {
    const { svc } = makeHarness();
    // surcharge : T101 lève une erreur non-E11000
    svc.diService.createDi = jest.fn(async (_i: any, opts: any) => {
      if (opts.forcedRef === 'T101') throw new Error('drive indisponible');
      return { _id: 'DI_' + opts.forcedRef };
    });
    const j = await svc.jobService.create({ createdBy: 'U1', total: 3 });
    await svc.processJob(j.jobId, [pr(100), pr(101), pr(102)], ctx());
    const r = await svc.jobService.getById(j.jobId);
    expect(r.status).toBe('COMPLETED'); // pas tout-ou-rien
    expect(r.report.crees.dis).toBe(2); // T100 + T102
    expect(r.report.erreurs).toHaveLength(1);
    expect(r.report.erreurs[0].motifs[0]).toMatch(/drive indisponible/);
  });
});

describe('Idempotence — job RUNNING interrompu (V1 sans réconciliation)', () => {
  it('serveur tué pendant RUNNING → le job RESTE RUNNING (documenté, pas de réconciliation auto)', async () => {
    const { svc } = makeHarness();
    const j = await svc.jobService.create({ createdBy: 'U1', total: 5 });
    await svc.jobService.markRunning(j.jobId);
    // « interruption serveur » : processJob n'est jamais terminé (aucun code ne
    // tourne pour marquer FAILED). En V1 (sans Redis/BullMQ ni réconciliation au
    // boot), le job demeure RUNNING — c'est le comportement attendu et documenté.
    const state = await svc.jobService.getById(j.jobId);
    expect(state.status).toBe('RUNNING');
  });
});
