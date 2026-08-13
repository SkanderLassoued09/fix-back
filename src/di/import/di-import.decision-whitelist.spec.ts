// DiService (importé transitivement) tire nanoid (ESM) → mock, comme les autres specs DI.
jest.mock('nanoid', () => ({ nanoid: () => 'rand' }));

import { DiImportService } from './di-import.service';
import { DiImportJobService } from './di-import-job.service';
import { isValidDecisionKind } from './tier-name.util';

/**
 * J2 — ROBUSTESSE du champ `kind` d'une décision d'ambiguïté « both ».
 *
 * Le backend ne doit JAMAIS accepter une valeur arbitraire au seul motif
 * qu'elle est « truthy ». Whitelist STRICTE : `kind ∈ { 'client', 'company' }`.
 * Toute autre valeur (forgée dans un payload multipart, ou envoyée par un futur
 * autre client) est rejetée — et surtout : AUCUNE DI sans rattachement de tiers
 * ne peut être créée par ce chemin.
 *
 * Défense sur DEUX niveaux, tous deux testés ici :
 *   1) `validate` : une ligne « both » sans décision VALIDE est marquée en
 *      erreur → jamais importée ;
 *   2) `processJob` : garde d'invariant — si une décision invalide atteignait
 *      malgré tout la création, on lève (erreur collectée par ligne) → 0 DI.
 */

// ---------------------------------------------------------------------------
// 1) Whitelist pure — isValidDecisionKind
// ---------------------------------------------------------------------------
describe('isValidDecisionKind — whitelist stricte', () => {
  it('accepte UNIQUEMENT « client » et « company »', () => {
    expect(isValidDecisionKind('client')).toBe(true);
    expect(isValidDecisionKind('company')).toBe(true);
  });

  it('rejette toute autre valeur (truthy incluse)', () => {
    for (const bad of [
      'foo',
      'companyxxx',
      'clientxxx',
      'true',
      '1',
      '',
      'CLIENT', // casse exacte exigée
      'Company',
      ' client', // pas de trim implicite
      {},
      [],
      0,
      1,
      true,
      false,
      null,
      undefined,
    ]) {
      expect(isValidDecisionKind(bad as unknown)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2) validate — une décision « both » n'est acceptée que si le kind est valide
// ---------------------------------------------------------------------------
function validateSvc(): any {
  const svc: any = Object.create(DiImportService.prototype);
  // resolveTier court-circuite sur « both » sans toucher aux alias, mais on
  // fournit un aliasService inerte par sûreté.
  svc.aliasService = { isValid: jest.fn().mockReturnValue(false) };
  return svc;
}

// Résolution « both » : « ACME » présent comme Client ET comme Société.
function bothResCtx() {
  return {
    clientCache: new Map<string, string>([['acme', 'C1']]),
    companyCache: new Map<string, string>([['acme', 'CMP1']]),
    clientIds: new Set<string>(['C1']),
    companyIds: new Set<string>(['CMP1']),
    aliasMap: new Map<string, any>(),
  };
}
const EXISTING = { refs: new Set<string>(), nextAuto: 999999 };

function bothRow(ligne = 1, name = 'ACME') {
  const nDi = `T${5000 + ligne}`;
  return {
    ligne,
    nDi,
    designation: 'D',
    nSerie: '***',
    clientName: name,
    rangement: '',
    dateValue: null,
    raw: { 'N° DI': nDi, Client: name },
  };
}

function validateWith(decisions: Map<number, any>) {
  const svc = validateSvc();
  return svc.validate([bothRow(1)], EXISTING, bothResCtx(), decisions);
}

describe('validate — décision « both » : whitelist du kind', () => {
  it('kind=client → ACCEPTÉ (ligne valide, rattachée au Client)', () => {
    const rep = validateWith(new Map([[1, 'client']]));
    expect(rep.erreurs).toHaveLength(0);
    expect(rep.valides).toBe(1);
    expect(rep.lignes[0].statut).toBe('avertissement');
    expect(rep.lignes[0].motifs.join(' ')).toMatch(/Ambiguïté résolue.*au Client/i);
  });

  it('kind=company → ACCEPTÉ (ligne valide, rattachée à la Société)', () => {
    const rep = validateWith(new Map([[1, 'company']]));
    expect(rep.erreurs).toHaveLength(0);
    expect(rep.valides).toBe(1);
    expect(rep.lignes[0].motifs.join(' ')).toMatch(/Ambiguïté résolue.*à la Société/i);
  });

  it.each([['foo'], ['companyxxx'], ['clientxxx'], ['true'], ['1'], ['CLIENT']])(
    'kind=%s → REJETÉ (ligne en erreur, non importée)',
    (bad) => {
      const rep = validateWith(new Map([[1, bad]]));
      expect(rep.valides).toBe(0);
      expect(rep.erreurs).toHaveLength(1);
      expect(rep.erreurs[0].ligne).toBe(1);
      expect(rep.erreurs[0].motifs[0]).toMatch(/Client ET comme Société/i);
    },
  );

  it('kind absent (aucune décision) → REJETÉ pour une ligne « both »', () => {
    const rep = validateWith(new Map()); // aucune décision fournie
    expect(rep.valides).toBe(0);
    expect(rep.erreurs).toHaveLength(1);
    expect(rep.erreurs[0].motifs[0]).toMatch(/Client ET comme Société/i);
  });
});

// ---------------------------------------------------------------------------
// 3) processJob — garde d'invariant : AUCUNE DI sans rattachement
// ---------------------------------------------------------------------------
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

function jobHarness() {
  const refStore = new Set<string>();
  const svc: any = Object.create(DiImportService.prototype);
  svc.jobService = new DiImportJobService(makeJobModel() as any);
  svc.diService = {
    createDi: jest.fn(async (_input: any, opts: any) => {
      if (opts?.forcedRef) refStore.add(opts.forcedRef);
      return { _id: 'DI_' + opts?.forcedRef };
    }),
  };
  svc.notificationGateway = { diImportProgress: jest.fn() };
  svc.logger = { warn: jest.fn(), error: jest.fn() };
  svc.clientsService = { createClient: jest.fn() };
  svc.locationService = { createlocation: jest.fn() };
  svc.locationModel = findReturning([]);
  svc.aliasService = {
    getAliasMap: jest.fn().mockResolvedValue(new Map()),
    isValid: jest.fn().mockReturnValue(false),
    record: jest.fn().mockResolvedValue({}),
  };
  return { svc, refStore };
}

const bothCtx = (kind: any) => ({
  clientCache: new Map<string, string>([['acme', 'C1']]),
  companyCache: new Map<string, string>([['acme', 'CMP1']]),
  createdBy: 'U1',
  decisions: new Map<number, any>([[1, kind]]),
});

describe('processJob — garde d’invariant (aucune DI sans rattachement)', () => {
  it('décision « both » FORGÉE (kind=foo) → 0 DI, 1 erreur, job COMPLETED', async () => {
    const { svc, refStore } = jobHarness();
    const job = await svc.jobService.create({ createdBy: 'U1', total: 1 });

    await svc.processJob(job.jobId, [bothRow(1)], bothCtx('foo'));

    const final = await svc.jobService.getById(job.jobId);
    expect(final.status).toBe('COMPLETED'); // pas tout-ou-rien
    expect(final.report.crees.dis).toBe(0); // AUCUNE DI créée
    expect(final.report.erreurs).toHaveLength(1);
    expect(final.report.erreurs[0].motifs[0]).toMatch(/ambiguïté invalide/i);
    expect(svc.diService.createDi).not.toHaveBeenCalled(); // jamais atteint la création
    expect(refStore.size).toBe(0); // aucun _idnum persisté
  });

  it('décision valide (company) → rattachée à la Société (régression)', async () => {
    const { svc } = jobHarness();
    const job = await svc.jobService.create({ createdBy: 'U1', total: 1 });
    await svc.processJob(job.jobId, [bothRow(1)], bothCtx('company'));
    const input = svc.diService.createDi.mock.calls[0][0];
    expect(input.company_id).toBe('CMP1');
    expect(input.client_id).toBeUndefined();
  });

  it('décision valide (client) → rattachée au Client (régression)', async () => {
    const { svc } = jobHarness();
    const job = await svc.jobService.create({ createdBy: 'U1', total: 1 });
    await svc.processJob(job.jobId, [bothRow(1)], bothCtx('client'));
    const input = svc.diService.createDi.mock.calls[0][0];
    expect(input.client_id).toBe('C1');
    expect(input.company_id).toBeUndefined();
  });
});
