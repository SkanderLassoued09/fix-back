import { Test, TestingModule } from '@nestjs/testing';
import { ReunionPVResolver } from './reunion-pv.resolver';
import { ReunionPVService } from './reunion-pv.service';

/**
 * Resolver-level guards:
 *  - createReunionPV forwards the input to the service
 *  - queries route to the right service method based on which arg is set
 *  - x-test-run header switches `skipDiscord` on
 */
describe('ReunionPVResolver', () => {
  let resolver: ReunionPVResolver;
  let service: {
    create: jest.Mock;
    findById: jest.Mock;
    findByDi: jest.Mock;
    findByCreatedBy: jest.Mock;
    findAll: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      create: jest.fn().mockResolvedValue({ _id: 'PV1' }),
      findById: jest.fn().mockResolvedValue({ _id: 'PV1' }),
      findByDi: jest.fn().mockResolvedValue([{ _id: 'PV1' }]),
      findByCreatedBy: jest.fn().mockResolvedValue([{ _id: 'PV2' }]),
      findAll: jest.fn().mockResolvedValue([{ _id: 'PV1' }, { _id: 'PV2' }]),
    } as any;
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReunionPVResolver,
        { provide: ReunionPVService, useValue: service },
      ],
    }).compile();
    resolver = mod.get(ReunionPVResolver);
  });

  it('createReunionPV forwards the input', async () => {
    const input: any = { titre: 'T', dateReunion: new Date(), createdById: 'P' };
    await resolver.createReunionPV(input, { req: { headers: {} } });
    expect(service.create).toHaveBeenCalledWith(input, { skipDiscord: false });
  });

  it('createReunionPV passes skipDiscord:true when x-test-run is 1', async () => {
    const input: any = { titre: 'T', dateReunion: new Date(), createdById: 'P' };
    await resolver.createReunionPV(input, {
      req: { headers: { 'x-test-run': '1' } },
    });
    expect(service.create).toHaveBeenCalledWith(input, { skipDiscord: true });
  });

  it('reunionPV → findById', async () => {
    await resolver.reunionPV('PV1');
    expect(service.findById).toHaveBeenCalledWith('PV1');
  });

  it('reunionPVs(diId) → findByDi', async () => {
    await resolver.reunionPVs('DI1', undefined);
    expect(service.findByDi).toHaveBeenCalledWith('DI1');
    expect(service.findByCreatedBy).not.toHaveBeenCalled();
  });

  it('reunionPVs(createdById) → findByCreatedBy', async () => {
    await resolver.reunionPVs(undefined, 'P1');
    expect(service.findByCreatedBy).toHaveBeenCalledWith('P1');
    expect(service.findByDi).not.toHaveBeenCalled();
  });

  it('reunionPVs() with no filter → findAll (used by the Réunions menu)', async () => {
    const out = await resolver.reunionPVs(undefined, undefined);
    expect(service.findAll).toHaveBeenCalledTimes(1);
    expect(out).toEqual([{ _id: 'PV1' }, { _id: 'PV2' }]);
    expect(service.findByDi).not.toHaveBeenCalled();
    expect(service.findByCreatedBy).not.toHaveBeenCalled();
  });
});
