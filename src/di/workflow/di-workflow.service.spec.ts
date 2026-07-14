import { Logger, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Role } from 'src/auth/roles';
import { StatService } from 'src/stat/stat.service';
import { STATUS_DI } from '../di.status';
import { Di } from '../entities/di.entity';
import { DiWorkflowService } from './di-workflow.service';

type DiModelMock = {
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
};

const makeDi = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: 'DI_test',
    status: STATUS_DI.Created.status,
    current_roles: STATUS_DI.Created.role,
    ignoreCount: 0,
    ...overrides,
  } as Di);

const makeDiModelMock = (): DiModelMock => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
});

const makeStatServiceMock = () => ({
  updateStatus: jest.fn(),
});

describe('DiWorkflowService', () => {
  let service: DiWorkflowService;
  let diModel: DiModelMock;
  let statService: ReturnType<typeof makeStatServiceMock>;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    diModel = makeDiModelMock();
    statService = makeStatServiceMock();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiWorkflowService,
        {
          provide: getModelToken(Di.name),
          useValue: diModel,
        },
        {
          provide: StatService,
          useValue: statService,
        },
      ],
    }).compile();

    service = module.get<DiWorkflowService>(DiWorkflowService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies MANAGER_TO_PENDING1 with status and current_roles', async () => {
    const existingDi = makeDi();
    const updatedDi = makeDi({
      status: STATUS_DI.Pending1.status,
      current_roles: STATUS_DI.Pending1.role,
    });

    diModel.findOne.mockResolvedValue(existingDi);
    diModel.findOneAndUpdate.mockResolvedValue(updatedDi);

    const result = await service.transition({
      diId: existingDi._id,
      transitionKey: 'MANAGER_TO_PENDING1',
      actorRole: Role.MANAGER,
    });

    expect(diModel.findOne).toHaveBeenCalledWith({ _id: existingDi._id });
    expect(diModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: existingDi._id },
      {
        $set: {
          status: STATUS_DI.Pending1.status,
          current_roles: STATUS_DI.Pending1.role,
        },
      },
      { new: true },
    );
    expect(statService.updateStatus).not.toHaveBeenCalled();
    expect(result.previousStatus).toBe(STATUS_DI.Created.status);
    expect(result.nextStatus).toBe(STATUS_DI.Pending1.status);
    expect(result.di).toBe(updatedDi);
  });

  it('warns but still applies transition when source status is unexpected', async () => {
    const existingDi = makeDi({ status: STATUS_DI.Finished.status });
    const updatedDi = makeDi({
      status: STATUS_DI.Pending1.status,
      current_roles: STATUS_DI.Pending1.role,
    });

    diModel.findOne.mockResolvedValue(existingDi);
    diModel.findOneAndUpdate.mockResolvedValue(updatedDi);

    await service.transition({
      diId: existingDi._id,
      transitionKey: 'MANAGER_TO_PENDING1',
      actorRole: Role.MANAGER,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("DI transition 'MANAGER_TO_PENDING1' expected"),
    );
    expect(diModel.findOneAndUpdate).toHaveBeenCalled();
  });

  it('throws when DI does not exist', async () => {
    diModel.findOne.mockResolvedValue(null);

    await expect(
      service.transition({
        diId: 'missing',
        transitionKey: 'MANAGER_TO_PENDING1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('syncs Stat.status when transition enables stat synchronization', async () => {
    const existingDi = makeDi({ status: STATUS_DI.Diagnostic.status });
    const updatedDi = makeDi({ status: STATUS_DI.InDiagnostic.status });

    diModel.findOne.mockResolvedValue(existingDi);
    diModel.findOneAndUpdate.mockResolvedValue(updatedDi);
    statService.updateStatus.mockResolvedValue({});

    await service.transition({
      diId: existingDi._id,
      transitionKey: 'CHANGE_STATUS_IN_DIAGNOSTIC',
      actorRole: Role.TECH,
    });

    expect(statService.updateStatus).toHaveBeenCalledWith(
      existingDi._id,
      STATUS_DI.InDiagnostic.status,
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('di.workflow.transition.success'),
    );
  });

  it('preserves ignoreCount when synchronizing Stat.status', async () => {
    const existingDi = makeDi({
      status: STATUS_DI.Diagnostic.status,
      ignoreCount: 2,
    });
    const updatedDi = makeDi({
      status: STATUS_DI.InDiagnostic.status,
      ignoreCount: 2,
    });

    diModel.findOne.mockResolvedValue(existingDi);
    diModel.findOneAndUpdate.mockResolvedValue(updatedDi);
    statService.updateStatus.mockResolvedValue({});

    await service.transition({
      diId: existingDi._id,
      transitionKey: 'CHANGE_STATUS_IN_DIAGNOSTIC',
      actorRole: Role.TECH,
    });

    expect(statService.updateStatus).toHaveBeenCalledWith(
      existingDi._id,
      STATUS_DI.InDiagnostic.status,
      2,
    );
  });

  // ── Status-divergence fix (T281/T282) ──────────────────────────────────
  // The Tech list renders Stat.status while the Coordinator view renders
  // Di.status. These two transitions used to leave Stat.status behind
  // (updateStatStatus:false) → the same DI showed PENDING2 to the coordinator
  // but INDIAGNOSTIC/DIAGNOSTIC_Pause to the tech. Now both sync the Stat.
  it('MAGASIN_TECH_TO_PENDING2 syncs Stat.status to PENDING2 (was the T281 bug)', async () => {
    const existingDi = makeDi({ status: STATUS_DI.InDiagnostic.status });
    const updatedDi = makeDi({ status: STATUS_DI.Pending2.status });
    diModel.findOne.mockResolvedValue(existingDi);
    diModel.findOneAndUpdate.mockResolvedValue(updatedDi);
    statService.updateStatus.mockResolvedValue({});

    await service.transition({
      diId: existingDi._id,
      transitionKey: 'MAGASIN_TECH_TO_PENDING2',
      actorRole: Role.TECH,
    });

    expect(statService.updateStatus).toHaveBeenCalledWith(
      existingDi._id,
      STATUS_DI.Pending2.status,
    );
  });

  it('MANAGER_ADMIN_TO_PENDING3 syncs Stat.status to PENDING3', async () => {
    const existingDi = makeDi({ status: STATUS_DI.Negotiation1.status });
    const updatedDi = makeDi({ status: STATUS_DI.Pending3.status });
    diModel.findOne.mockResolvedValue(existingDi);
    diModel.findOneAndUpdate.mockResolvedValue(updatedDi);
    statService.updateStatus.mockResolvedValue({});

    await service.transition({
      diId: existingDi._id,
      transitionKey: 'MANAGER_ADMIN_TO_PENDING3',
      actorRole: Role.MANAGER,
    });

    expect(statService.updateStatus).toHaveBeenCalledWith(
      existingDi._id,
      STATUS_DI.Pending3.status,
    );
  });

  it('logs and rethrows Stat.status synchronization failures', async () => {
    const existingDi = makeDi({ status: STATUS_DI.Diagnostic.status });
    const updatedDi = makeDi({ status: STATUS_DI.InDiagnostic.status });
    const statError = new Error('stat sync failed');

    diModel.findOne.mockResolvedValue(existingDi);
    diModel.findOneAndUpdate.mockResolvedValue(updatedDi);
    statService.updateStatus.mockRejectedValue(statError);

    await expect(
      service.transition({
        diId: existingDi._id,
        transitionKey: 'CHANGE_STATUS_IN_DIAGNOSTIC',
        actorRole: Role.TECH,
      }),
    ).rejects.toThrow(statError);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('workflow.stat_sync_failed'),
    );
  });
});
