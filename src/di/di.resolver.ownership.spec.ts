// nanoid is ESM-only and DiService (pulled in via DiResolver) imports it;
// Jest's default transform can't parse it, so stub it before the import graph
// loads. Irrelevant to this suite — the ownership guard never touches nanoid.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { ForbiddenException } from '@nestjs/common';
import { DiResolver } from './di.resolver';
import { StatService } from 'src/stat/stat.service';

/**
 * Proves the backend enforces the "a technician may only act on DIs assigned
 * to themselves" rule at the resolver boundary — i.e. even a direct GraphQL
 * call (bypassing the greyed frontend button) is refused for someone else's DI.
 *
 * We call the resolver methods directly with a @CurrentUser payload and a real
 * StatService whose Mongo model is stubbed, so the genuine ownership guard runs.
 */

const OWNER: any = { _id: 'U1', username: 'alice', role: 'ADMIN_TECH' };
const OTHER: any = { _id: 'U2', username: 'bob', role: 'TECH' };

const makeStatModel = (statDoc: any) => ({
  findOne: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(statDoc),
      }),
    }),
  }),
});

// StatService has 11 constructor deps; only StatModel is exercised by
// assertTechOwnsDi, so the rest are inert stubs.
const makeStatService = (statDoc: any): StatService =>
  new StatService(
    makeStatModel(statDoc) as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

const makeDiService = () => ({
  changeStatusInRepair: jest.fn().mockResolvedValue({ status: 'INREPARATION' }),
  changeStatusInDiagnostic: jest.fn().mockResolvedValue(true),
  tech_startReperation: jest.fn().mockReturnValue(Promise.resolve(true)),
  tech_startDiagnostic: jest.fn().mockReturnValue(Promise.resolve(true)),
  tech_finishReperation: jest.fn().mockResolvedValue({ status: 'FINISHED' }),
  changeStateInReparationPause: jest
    .fn()
    .mockResolvedValue({ status: 'REPARATION_Pause' }),
  changeToDiagnosticInPause: jest
    .fn()
    .mockReturnValue({ status: 'DIAGNOSTIC_Pause' }),
});

describe('DiResolver — technician ownership enforcement', () => {
  let diService: ReturnType<typeof makeDiService>;
  let resolver: DiResolver;

  // Stat assigned to OWNER for both diagnostic and repair.
  const ownedStat = { id_tech_diag: 'U1', id_tech_rep: 'U1' };

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    diService = makeDiService();
    resolver = new DiResolver(
      diService as any,
      makeStatService(ownedStat),
      {} as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('Réparation — changeStatusInRepair', () => {
    it('ALLOWS the assigned technician (their own DI)', async () => {
      await expect(resolver.changeStatusInRepair(OWNER, 'DI1')).resolves.toBe(
        true,
      );
      expect(diService.changeStatusInRepair).toHaveBeenCalledWith('DI1');
    });

    it('REFUSES another technician (someone else’s DI), even via direct API', async () => {
      await expect(resolver.changeStatusInRepair(OTHER, 'DI1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(diService.changeStatusInRepair).not.toHaveBeenCalled();
    });
  });

  describe('Diagnostic — changeStatusInDiagnostic', () => {
    it('ALLOWS the assigned technician', async () => {
      await expect(
        resolver.changeStatusInDiagnostic(OWNER, 'DI1'),
      ).resolves.toBe(true);
      expect(diService.changeStatusInDiagnostic).toHaveBeenCalledWith('DI1');
    });

    it('REFUSES another technician', async () => {
      await expect(
        resolver.changeStatusInDiagnostic(OTHER, 'DI1'),
      ).rejects.toThrow(ForbiddenException);
      expect(diService.changeStatusInDiagnostic).not.toHaveBeenCalled();
    });
  });

  describe('tech_startReperation / tech_finishReperation / pauses', () => {
    it('ALLOWS the assigned technician to start & pause', async () => {
      await expect(resolver.tech_startReperation(OWNER, 'DI1')).resolves.toBe(
        true,
      );
      await expect(
        resolver.changeToReparationInPause(OWNER, 'DI1'),
      ).resolves.toEqual({ status: 'REPARATION_Pause' });
    });

    it('REFUSES another technician to start, finish or pause', async () => {
      await expect(resolver.tech_startReperation(OTHER, 'DI1')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        resolver.tech_finishReperation(OTHER, 'DI1', 'x'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        resolver.changeToReparationInPause(OTHER, 'DI1'),
      ).rejects.toThrow(ForbiddenException);
      expect(diService.tech_startReperation).not.toHaveBeenCalled();
      expect(diService.tech_finishReperation).not.toHaveBeenCalled();
    });
  });

  it('matches a legacy DI stored under the username (ADMIN_TECH regression)', async () => {
    resolver = new DiResolver(
      diService as any,
      makeStatService({ id_tech_rep: 'alice' }),
      {} as any,
    );
    await expect(resolver.changeStatusInRepair(OWNER, 'DI1')).resolves.toBe(
      true,
    );
  });

  it('REFUSES when the DI has no Stat/assignment at all', async () => {
    resolver = new DiResolver(
      diService as any,
      makeStatService(null),
      {} as any,
    );
    await expect(resolver.changeStatusInRepair(OWNER, 'DI1')).rejects.toThrow(
      ForbiddenException,
    );
  });
});
