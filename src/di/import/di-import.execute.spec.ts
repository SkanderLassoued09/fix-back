// nanoid ESM → mock (DiImportService importe DiService transitivement + jobId).
let nanoidCalls = 0;
jest.mock('nanoid', () => ({ nanoid: () => `id${++nanoidCalls}` }));

import * as XLSX from 'xlsx';
import { DiImportService } from './di-import.service';
import { DiImportJobService } from './di-import-job.service';

/**
 * Étape 2 — exécution en JOB par lots + progression WebSocket.
 * `processJob` testé directement (déterministe), `executeAsJob` pour le
 * fire-and-forget. Modèle de job simulé en mémoire (transitions réelles).
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
    find: jest.fn((q: any) => ({
      sort: () => ({ lean: async () => [...store.values()].filter((d) => d.createdBy === q.createdBy) }),
    })),
    findOneAndUpdate: jest.fn(async (q: any, upd: any) => {
      const d = store.get(q.jobId);
      if (!d) return null;
      if (upd.$set) Object.assign(d, upd.$set);
      if (upd.$inc) for (const k of Object.keys(upd.$inc)) d[k] = (d[k] ?? 0) + upd.$inc[k];
      d.updatedAt = new Date();
      return d;
    }),
  };
}

function findReturning(rows: any[]) {
  return { find: jest.fn().mockReturnValue({ lean: async () => rows }) };
}

function makeExecSvc(
  opts: {
    createDi?: (...a: any[]) => any;
    jobService?: any;
    existingDi?: any[];
  } = {},
) {
  const svc: any = Object.create(DiImportService.prototype);
  svc.jobService =
    opts.jobService ?? new DiImportJobService(makeJobModel() as any);
  svc.diService = {
    createDi: jest.fn(opts.createDi ?? (async () => ({ _id: 'DI_x' }))),
  };
  const progress: any[] = [];
  svc.notificationGateway = {
    diImportProgress: jest.fn((p: any) => progress.push({ ...p })),
  };
  svc.logger = { warn: jest.fn(), error: jest.fn() };
  let seq = 0;
  svc.clientsService = {
    createClient: jest.fn(async (i: any) => ({ _id: `C${++seq}`, ...i })),
  };
  svc.locationService = {
    createlocation: jest.fn(async (i: any) => ({ _id: `L${++seq}`, ...i })),
  };
  svc.locationModel = findReturning([]);
  svc.diModel = findReturning(opts.existingDi ?? []);
  svc.clientModel = findReturning([]);
  svc.companyModel = findReturning([]);
  svc.aliasService = {
    getAliasMap: jest.fn().mockResolvedValue(new Map()),
    isValid: jest.fn().mockReturnValue(false),
    record: jest.fn().mockResolvedValue({}),
  };
  return { svc, progress };
}

function pr(n: number, name = 'ACME', rangement = '') {
  const nDi = `T${n}`;
  return {
    ligne: n + 4,
    nDi,
    designation: 'D' + n,
    nSerie: '***',
    clientName: name,
    rangement,
    dateValue: null,
    raw: { 'N° DI': nDi, Désignation: 'D' + n, Client: name },
  };
}
const ctx = () => ({ clientCache: new Map(), companyCache: new Map(), createdBy: 'U1' });

beforeEach(() => (nanoidCalls = 0));

describe('processJob — batches, progression, COMPLETED', () => {
  it('PENDING → RUNNING → COMPLETED ; progression cumulative ; jobId + total dans chaque event', async () => {
    const { svc, progress } = makeExecSvc();
    const rows = Array.from({ length: 60 }, (_, i) => pr(i + 1));
    const job = await svc.jobService.create({ createdBy: 'U1', total: rows.length });
    expect(job.status).toBe('PENDING');

    await svc.processJob(job.jobId, rows, ctx());

    const final = await svc.jobService.getById(job.jobId);
    expect(final.status).toBe('COMPLETED');
    expect(final.report.crees.dis).toBe(60);
    expect(svc.diService.createDi).toHaveBeenCalledTimes(60); // 3 lots (25+25+10)
    // Bornes de lot + cycle de vie = les évènements SANS `detail` (les évènements
    // `detail` sont le suivi ligne par ligne, additif). La progression cumulative
    // se lit sur ces bornes : initial(0) + 3 lots(25,50,60) + COMPLETED(60).
    const boundary = progress.filter((p) => !p.detail);
    expect(boundary.map((p) => p.done)).toEqual([0, 25, 50, 60, 60]);
    expect(boundary.map((p) => p.phase)).toEqual([
      'RUNNING', 'RUNNING', 'RUNNING', 'RUNNING', 'COMPLETED',
    ]);
    expect(boundary.map((p) => p.currentRef)).toEqual([null, 'T25', 'T50', 'T60', null]);
    // Suivi ligne par ligne : des évènements `detail` sont bien émis.
    expect(progress.some((p) => !!p.detail)).toBe(true);
    // jobId + total présents dans CHAQUE évènement (bornes ET détails).
    expect(progress.every((p) => p.jobId === job.jobId)).toBe(true);
    expect(progress.every((p) => p.total === 60)).toBe(true);
  });

  it('forcedRef : chaque createDi reçoit la référence du fichier + skipNotify', async () => {
    const { svc } = makeExecSvc();
    const rows = [pr(1400), pr(1401)];
    const job = await svc.jobService.create({ createdBy: 'U1', total: 2 });
    await svc.processJob(job.jobId, rows, ctx());
    const opts = svc.diService.createDi.mock.calls.map((c: any[]) => c[1]);
    expect(opts).toEqual([
      { forcedRef: 'T1400', skipNotify: true },
      { forcedRef: 'T1401', skipNotify: true },
    ]);
  });
});

describe('processJob — idempotence & erreurs', () => {
  it('référence déjà en base (E11000) → IGNORÉE, ni recréée ni en erreur, job COMPLETED', async () => {
    const dupErr = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    let call = 0;
    const { svc } = makeExecSvc({
      createDi: async () => {
        call++;
        if (call === 2) throw dupErr;
        return {};
      },
    });
    const rows = [pr(1), pr(2), pr(3)];
    const job = await svc.jobService.create({ createdBy: 'U1', total: 3 });
    await svc.processJob(job.jobId, rows, ctx());
    const final = await svc.jobService.getById(job.jobId);
    expect(final.status).toBe('COMPLETED');
    expect(final.report.crees.dis).toBe(2);
    expect(final.report.crees.ignorees).toBe(1);
    expect(final.report.erreurs).toHaveLength(0);
  });

  it('erreur de création NON-duplicate → collectée, job COMPLETED (pas tout-ou-rien)', async () => {
    let call = 0;
    const { svc } = makeExecSvc({
      createDi: async () => {
        call++;
        if (call === 2) throw new Error('drive down');
        return {};
      },
    });
    const rows = [pr(1), pr(2), pr(3)];
    const job = await svc.jobService.create({ createdBy: 'U1', total: 3 });
    await svc.processJob(job.jobId, rows, ctx());
    const final = await svc.jobService.getById(job.jobId);
    expect(final.status).toBe('COMPLETED');
    expect(final.report.crees.dis).toBe(2);
    expect(final.report.erreurs).toHaveLength(1);
    expect(final.report.erreurs[0].motifs[0]).toMatch(/drive down/);
  });

  it('erreur FATALE (infra) → FAILED + erreur stockée ; lignes déjà créées CONSERVÉES', async () => {
    const calls = {
      markRunning: jest.fn(async () => ({})),
      incrementProgress: jest.fn(async () => ({ done: 2 })),
      complete: jest.fn(async () => {
        throw new Error('db lost');
      }),
      fail: jest.fn(async () => ({})),
    };
    const { svc } = makeExecSvc({ jobService: calls });
    const rows = [pr(1), pr(2)];
    await svc.processJob('JOB1', rows, ctx());
    // les 2 DI ont été créées AVANT l'échec du complete → conservées
    expect(svc.diService.createDi).toHaveBeenCalledTimes(2);
    expect(calls.fail).toHaveBeenCalledTimes(1);
    const [failJobId, failMsg, failReport] = calls.fail.mock.calls[0] as any[];
    expect(failJobId).toBe('JOB1');
    expect(failMsg).toMatch(/db lost/);
    expect(failReport.crees.dis).toBe(2); // rapport partiel conserve les créées
  });
});

describe('processJob — résolution d’ambiguïté (décision utilisateur)', () => {
  it('« both » : la décision pilote le rattachement (Société vs Client)', async () => {
    const { svc } = makeExecSvc();
    const clientCache = new Map([['acme', 'C1']]);
    const companyCache = new Map([['acme', 'CMP1']]);
    const rows = [pr(1, 'ACME'), pr(2, 'ACME')];
    const decisions = new Map<number, 'client' | 'company'>([
      [rows[0].ligne, 'company'],
      [rows[1].ligne, 'client'],
    ]);
    const job = await svc.jobService.create({ createdBy: 'U1', total: 2 });
    await svc.processJob(job.jobId, rows, {
      clientCache,
      companyCache,
      createdBy: 'U1',
      decisions,
    });
    const inputs = svc.diService.createDi.mock.calls.map((c: any[]) => c[0]);
    expect(inputs[0].company_id).toBe('CMP1');
    expect(inputs[0].client_id).toBeUndefined();
    expect(inputs[1].client_id).toBe('C1');
    expect(inputs[1].company_id).toBeUndefined();
    // aucune création de client (les deux rattachés à de l'existant)
    expect(svc.clientsService.createClient).not.toHaveBeenCalled();
  });
});

describe('processJob — isolation du job', () => {
  it('ne touche QUE le jobId fourni', async () => {
    const calls = {
      markRunning: jest.fn(async () => ({})),
      incrementProgress: jest.fn(async () => ({ done: 1 })),
      complete: jest.fn(async () => ({})),
      fail: jest.fn(async () => ({})),
    };
    const { svc } = makeExecSvc({ jobService: calls });
    await svc.processJob('JOB_X', [pr(1)], ctx());
    expect(calls.markRunning).toHaveBeenCalledWith('JOB_X');
    expect(calls.incrementProgress.mock.calls.every((c: any[]) => c[0] === 'JOB_X')).toBe(true);
    expect(calls.complete).toHaveBeenCalledWith('JOB_X', expect.anything());
    expect(calls.fail).not.toHaveBeenCalled();
  });
});

describe('executeAsJob — fire-and-forget', () => {
  function buildXlsx(headers: any[], dataRows: any[][]): Buffer {
    const aoa: any[][] = [[], [], []]; // 3 lignes vides (header en ligne 4)
    aoa.push(headers);
    for (const r of dataRows) aoa.push(r);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'DI');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }
  const HEADERS = ['N° DI', 'Désignation', 'N° Série', 'Client', 'Date de réception', 'Rangement'];

  it('crée le job, renvoie {jobId,total}, et lance processJob en arrière-plan', async () => {
    const { svc } = makeExecSvc({ existingDi: [] });
    const spy = jest.spyOn(svc, 'processJob').mockResolvedValue(undefined);
    const buf = buildXlsx(HEADERS, [
      ['T1', 'A', '***', 'ACME', '', ''],
      ['T2', 'B', '***', 'ACME', '', ''],
    ]);
    const res = await svc.executeAsJob(buf, { createdBy: 'U1' });
    expect(res.jobId).toMatch(/^IMPORT_/);
    expect(res.total).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(res.jobId); // même jobId
  });

  it('en-tête invalide → aucun job créé, rapport de rejet renvoyé', async () => {
    const { svc } = makeExecSvc();
    const spy = jest.spyOn(svc, 'processJob');
    const buf = buildXlsx(['N° DI', 'Désignation', 'Rangement'], [['T1', 'A', 'X']]);
    const res = await svc.executeAsJob(buf, { createdBy: 'U1' });
    expect(res.jobId).toBeUndefined();
    expect(res.report.enTeteInvalide).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
