// StatService imports pull in `nanoid` (ESM-only) through the graph; stub it so
// ts-jest can load the module. Irrelevant to these tests.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { ForbiddenException } from '@nestjs/common';
import { StatService } from './stat.service';

/**
 * Manager gate — diagnostic technician (re)assignment.
 *
 * Business rule: after a Retour, the coordinator can NOT (re)assign the
 * diagnostic technician until the manager relaunches the DI into the flow
 * (status → PENDING1). `createStat` enforces it server-side so a direct API
 * call can't bypass the greyed-out UI dropdown.
 */
describe('StatService.createStat — Retour manager gate', () => {
  function makeSvc(diStatus: string) {
    const svc: any = Object.create(StatService.prototype);
    svc.generateStatId = jest.fn().mockResolvedValue(1);
    svc.diModel = {
      findOne: jest.fn().mockResolvedValue({
        _id: 'DI1',
        _idnum: 'T300',
        title: 'demo',
        status: diStatus,
        ignoreCount: diStatus.startsWith('RETOUR') ? 1 : 0,
      }),
    };
    svc.logsDiService = { create: jest.fn() };
    const saved = { _id: 's1', id_tech_diag: 'u1' };
    svc.StatModel = jest
      .fn()
      .mockImplementation(() => ({ save: jest.fn().mockResolvedValue(saved) }));
    svc.StatModel.findOne = jest
      .fn()
      .mockResolvedValue({ toObject: () => saved });
    svc.profileService = {
      findProlileById: jest
        .fn()
        .mockResolvedValue({ _id: 'u1', firstName: 'tech' }),
    };
    svc.notificationGateway = { updateTicket: jest.fn() };
    svc.operationalErrorService = { capture: jest.fn() };
    return svc;
  }

  it('REFUSES diagnostic assignment while the DI is in a Retour cycle', async () => {
    const svc = makeSvc('RETOUR1');
    await expect(
      svc.createStat({ _idDi: 'DI1', id_tech_diag: 'u1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Rejected before persisting: the Stat is never created.
    expect(svc.StatModel).not.toHaveBeenCalled();
  });

  it('REFUSES on RETOUR2 and RETOUR3 as well', async () => {
    for (const s of ['RETOUR2', 'RETOUR3']) {
      const svc = makeSvc(s);
      await expect(
        svc.createStat({ _idDi: 'DI1', id_tech_diag: 'u1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('ALLOWS diagnostic assignment at PENDING1', async () => {
    const svc = makeSvc('PENDING1');
    const res = await svc.createStat({ _idDi: 'DI1', id_tech_diag: 'u1' });
    expect(res).toBeTruthy();
    expect(res.status).toBe('PENDING1');
    // Persistence path reached exactly once.
    expect(svc.StatModel).toHaveBeenCalledTimes(1);
  });

  it('does NOT gate a repair-only assignment (no id_tech_diag)', async () => {
    // Repair assignment carries id_tech_rep and happens at PENDING3 — the gate
    // must ignore it even if, hypothetically, the DI were in a Retour status.
    const svc = makeSvc('RETOUR1');
    const res = await svc.createStat({ _idDi: 'DI1', id_tech_rep: 'r1' });
    expect(res).toBeTruthy();
  });
});
