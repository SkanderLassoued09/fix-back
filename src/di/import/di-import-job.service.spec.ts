// nanoid is ESM-only → mock deterministically so jobIds are predictable.
let nanoidCalls = 0;
jest.mock('nanoid', () => ({ nanoid: () => `id${++nanoidCalls}` }));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DiImportJobService } from './di-import-job.service';

/**
 * Cycle de vie + sécurité des jobs d'import (`di_import_jobs`).
 *
 * Modèle Mongo simulé en mémoire (Map jobId → doc) pour reproduire fidèlement
 * `create` / `findOne().lean()` / `findOneAndUpdate({new})` / `find().sort().lean()`
 * ($set + $inc atomiques inclus) — aucune dépendance Mongo réelle.
 */
function makeModel() {
  const store = new Map<string, any>();
  return {
    _store: store,
    create: jest.fn(async (doc: any) => {
      const d = { ...doc, createdAt: new Date(), updatedAt: new Date() };
      store.set(doc.jobId, d);
      return d;
    }),
    findOne: jest.fn((q: any) => ({
      lean: async () => store.get(q.jobId) ?? null,
    })),
    find: jest.fn((q: any) => ({
      sort: () => ({
        lean: async () =>
          [...store.values()].filter((d) => d.createdBy === q.createdBy),
      }),
    })),
    findOneAndUpdate: jest.fn(async (q: any, upd: any) => {
      const d = store.get(q.jobId);
      if (!d) return null;
      if (upd.$set) Object.assign(d, upd.$set);
      if (upd.$inc) {
        for (const k of Object.keys(upd.$inc)) d[k] = (d[k] ?? 0) + upd.$inc[k];
      }
      d.updatedAt = new Date();
      return d;
    }),
  };
}

function makeSvc() {
  const model = makeModel();
  const svc = new DiImportJobService(model as any);
  return { svc, model };
}

beforeEach(() => (nanoidCalls = 0));

describe('DiImportJobService — cycle de vie', () => {
  it('create() → PENDING, jobId préfixé, done=0, total & createdBy posés', async () => {
    const { svc } = makeSvc();
    const job = await svc.create({ createdBy: 'U1', total: 42 });
    expect(job.jobId).toBe('IMPORT_id1');
    expect(job.status).toBe('PENDING');
    expect(job.done).toBe(0);
    expect(job.total).toBe(42);
    expect(job.createdBy).toBe('U1');
  });

  it('total négatif est ramené à 0 (garde)', async () => {
    const { svc } = makeSvc();
    const job = await svc.create({ createdBy: 'U1', total: -5 });
    expect(job.total).toBe(0);
  });

  it('markRunning → RUNNING', async () => {
    const { svc } = makeSvc();
    const j = await svc.create({ createdBy: 'U1', total: 10 });
    const r = await svc.markRunning(j.jobId);
    expect(r.status).toBe('RUNNING');
  });

  it('incrementProgress avance done de façon cumulative + pose currentRef', async () => {
    const { svc } = makeSvc();
    const j = await svc.create({ createdBy: 'U1', total: 100 });
    await svc.incrementProgress(j.jobId, 25, 'T1400');
    const after = await svc.incrementProgress(j.jobId, 25, 'T1450');
    expect(after.done).toBe(50);
    expect(after.currentRef).toBe('T1450');
  });

  it('complete → COMPLETED + rapport stocké, currentRef effacé', async () => {
    const { svc } = makeSvc();
    const j = await svc.create({ createdBy: 'U1', total: 2 });
    await svc.incrementProgress(j.jobId, 2, 'T1');
    const r = await svc.complete(j.jobId, { dis: 2, ignorees: 0 });
    expect(r.status).toBe('COMPLETED');
    expect(r.report).toEqual({ dis: 2, ignorees: 0 });
    expect(r.currentRef).toBeNull();
  });

  it('fail → FAILED + message d’erreur (et rapport partiel optionnel)', async () => {
    const { svc } = makeSvc();
    const j = await svc.create({ createdBy: 'U1', total: 5 });
    const r = await svc.fail(j.jobId, 'boom', { dis: 3 });
    expect(r.status).toBe('FAILED');
    expect(r.error).toBe('boom');
    expect(r.report).toEqual({ dis: 3 });
  });
});

describe('DiImportJobService — récupération après réouverture', () => {
  it('getById retrouve l’état PERSISTÉ du job (survit à la « fermeture »)', async () => {
    const { svc } = makeSvc();
    const j = await svc.create({ createdBy: 'U1', total: 10 });
    await svc.markRunning(j.jobId);
    await svc.incrementProgress(j.jobId, 4, 'T99');
    // « réouverture » : nouvelle lecture, état conservé
    const recovered = await svc.getById(j.jobId);
    expect(recovered.status).toBe('RUNNING');
    expect(recovered.done).toBe(4);
    expect(recovered.currentRef).toBe('T99');
  });

  it('listForUser ne renvoie que les jobs de l’utilisateur', async () => {
    const { svc } = makeSvc();
    await svc.create({ createdBy: 'U1', total: 1 });
    await svc.create({ createdBy: 'U2', total: 1 });
    await svc.create({ createdBy: 'U1', total: 1 });
    const mine = await svc.listForUser('U1');
    expect(mine).toHaveLength(2);
    expect(mine.every((j) => j.createdBy === 'U1')).toBe(true);
  });
});

describe('DiImportJobService — sécurité (propriétaire)', () => {
  it('getForUser : le propriétaire accède', async () => {
    const { svc } = makeSvc();
    const j = await svc.create({ createdBy: 'U1', total: 1 });
    const got = await svc.getForUser(j.jobId, 'U1');
    expect(got.jobId).toBe(j.jobId);
  });

  it('getForUser : un AUTRE utilisateur est refusé (Forbidden)', async () => {
    const { svc } = makeSvc();
    const j = await svc.create({ createdBy: 'U1', total: 1 });
    await expect(svc.getForUser(j.jobId, 'U2')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('getForUser : allowAny (rôle autorisé) court-circuite le contrôle', async () => {
    const { svc } = makeSvc();
    const j = await svc.create({ createdBy: 'U1', total: 1 });
    const got = await svc.getForUser(j.jobId, 'ADMIN', true);
    expect(got.jobId).toBe(j.jobId);
  });

  it('getForUser : job inexistant → NotFound', async () => {
    const { svc } = makeSvc();
    await expect(svc.getForUser('IMPORT_nope', 'U1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
