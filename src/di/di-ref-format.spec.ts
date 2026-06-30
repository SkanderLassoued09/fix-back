// nanoid is ESM-only → mock so importing DiService doesn't blow up under jest.
jest.mock('nanoid', () => ({ nanoid: () => 'rand' }));

import { DiService } from './di.service';

/**
 * DI reference format: `DI{n}` → `T{n}` (e.g. T1562).
 *  - the NUMBER keeps incrementing across the rename (max of DI{n} ∪ T{n} + 1),
 *  - existing legacy `DI{n}` rows are never rewritten,
 *  - `_id` stays a random `DI_<nanoid>` (it's not the human reference).
 *
 * Built with `Object.create(DiService.prototype)` + manual mock fields so we
 * skip the 16-arg constructor (same pattern as di.resolve-drive-target.spec).
 */

function svcWithIds(rows: Array<{ _idnum: string }>) {
  const s: any = Object.create(DiService.prototype);
  s.diModel = {
    find: jest.fn().mockReturnValue({ lean: () => Promise.resolve(rows) }),
  };
  return s;
}

describe('DI reference — generateClientId (next number, DI ∪ T)', () => {
  it('continues from the last legacy DI{n} (DI1561 → 1562)', async () => {
    const s = svcWithIds([{ _idnum: 'DI1560' }, { _idnum: 'DI1561' }]);
    expect(await s.generateClientId()).toBe(1562);
  });

  it('counts existing T{n} refs so a new one never collides', async () => {
    const s = svcWithIds([
      { _idnum: 'DI1561' },
      { _idnum: 'T1562' },
      { _idnum: 'T1563' },
    ]);
    expect(await s.generateClientId()).toBe(1564);
  });

  it('ignores junk ids (INMAG-/DINaN), never NaN', async () => {
    const s = svcWithIds([
      { _idnum: 'INMAG-xy' },
      { _idnum: 'T7' },
      { _idnum: 'DINaN' },
    ]);
    const n = await s.generateClientId();
    expect(n).toBe(8);
    expect(Number.isNaN(n)).toBe(false);
  });
});

describe('DI reference — createDi assigns T{n}, leaves existing untouched', () => {
  function buildSvc(existing: Array<{ _idnum: string }>) {
    let saved: any = null;
    function DiModel(this: any, input: any) {
      Object.assign(this, input);
    }
    DiModel.prototype.save = async function () {
      saved = this;
      return this;
    };
    (DiModel as any).find = jest
      .fn()
      .mockReturnValue({ lean: () => Promise.resolve(existing) });

    const svc: any = Object.create(DiService.prototype);
    svc.diModel = DiModel;
    svc.syncEmplacementStats = jest.fn().mockResolvedValue(undefined);
    svc.discordHookService = { sendDiPendingNotification: jest.fn() };
    svc.operationalErrorService = { capture: jest.fn() };
    return { svc, getSaved: () => saved };
  }

  it('new DI gets a T{n} ref continuing the max (DI1561 → T1562); _id stays random', async () => {
    const { svc, getSaved } = buildSvc([{ _idnum: 'DI1561' }]);
    const di = await svc.createDi({ status: 'CREATED', location_id: 'L1', title: 'x' });
    expect(di._idnum).toBe('T1562');
    expect(getSaved()._idnum).toBe('T1562');
    expect(String(di._id)).toMatch(/^DI_/); // random id, NOT the reference
  });

  it('next creation increments (… T1562 present → T1563)', async () => {
    const { svc } = buildSvc([{ _idnum: 'DI1561' }, { _idnum: 'T1562' }]);
    const di = await svc.createDi({ status: 'CREATED', location_id: 'L1' });
    expect(di._idnum).toBe('T1563');
  });

  it('existing legacy DIs are NOT rewritten (only the new ref is inserted)', async () => {
    const existing = [{ _idnum: 'DI0' }, { _idnum: 'DI1561' }];
    const { svc } = buildSvc(existing);
    await svc.createDi({ status: 'CREATED', location_id: 'L1' });
    expect(existing).toEqual([{ _idnum: 'DI0' }, { _idnum: 'DI1561' }]);
  });

  it('no zero-padding (T1562, not T01562)', async () => {
    const { svc } = buildSvc([{ _idnum: 'DI1561' }]);
    const di = await svc.createDi({ status: 'CREATED', location_id: 'L1' });
    expect(di._idnum).toBe('T1562');
    expect(di._idnum).not.toMatch(/T0\d/);
  });
});
