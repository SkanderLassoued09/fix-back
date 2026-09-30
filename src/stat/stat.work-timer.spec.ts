import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { StatService } from './stat.service';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';
import { LogsDiService } from 'src/logs-di/logs-di.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';

/**
 * `getWorkTimer` — l'instantané qui fait FOI pour l'affichage du chrono.
 *
 * Un segment n'est « en cours » que si l'ancre est posée, que le Stat est le
 * cycle COURANT de la DI, que la DI est dans le statut actif de la phase et que
 * le segment est plausible (≤ 12 h). Sinon on n'affiche que le cumul.
 */
const NOW = new Date('2026-09-30T10:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const lean = (v: any) => ({
  lean: jest.fn().mockResolvedValue(v),
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(v) }),
});

describe('StatService.getWorkTimer', () => {
  let service: StatService;
  let statModel: { findOne: jest.Mock };
  let diModel: { findOne: jest.Mock };

  async function build(stat: any, di: any) {
    statModel = { findOne: jest.fn().mockReturnValue(lean(stat)) };
    diModel = { findOne: jest.fn().mockReturnValue(lean(di)) };
    const anyModel = { findOne: jest.fn(), updateOne: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StatService,
        { provide: getModelToken('Stat'), useValue: statModel },
        { provide: getModelToken('Di'), useValue: diModel },
        { provide: getModelToken('Profile'), useValue: anyModel },
        { provide: getModelToken('Company'), useValue: anyModel },
        { provide: getModelToken('Location'), useValue: anyModel },
        { provide: getModelToken('Client'), useValue: anyModel },
        { provide: NotificationsGateway, useValue: { updateTicket: jest.fn() } },
        { provide: ProfileService, useValue: {} },
        { provide: LogsDiService, useValue: {} },
        { provide: DiscordHookService, useValue: {} },
        { provide: OperationalErrorService, useValue: { capture: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(StatService);
  }

  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  it('diagnostic EN COURS : cumul + ancre + serverNow', async () => {
    await build(
      {
        _id: 'S1',
        _idDi: 'DI1',
        ignoreCount: 2,
        diag_time: '00:10:00',
        diagRunStartedAt: minutesAgo(5),
      },
      { status: 'INDIAGNOSTIC', ignoreCount: 2 },
    );
    const t = await service.getWorkTimer('S1');
    expect(t.status).toBe('INDIAGNOSTIC');
    expect(t.diag.accumulatedMs).toBe(10 * 60_000);
    expect(t.diag.runningSince).toEqual(minutesAgo(5));
    expect(t.rep).toEqual({ accumulatedMs: 0, runningSince: null });
    expect(t.serverNow).toEqual(NOW);
  });

  it('premier démarrage (diag_time absent, cas T1410) : cumul 0, en cours', async () => {
    await build(
      { _id: 'S1', _idDi: 'DI1', ignoreCount: 2, diagRunStartedAt: NOW },
      { status: 'INDIAGNOSTIC', ignoreCount: 2 },
    );
    const t = await service.getWorkTimer('S1');
    expect(t.diag).toEqual({ accumulatedMs: 0, runningSince: NOW });
  });

  it('en PAUSE : ancre ignorée, cumul seul', async () => {
    await build(
      {
        _id: 'S1',
        _idDi: 'DI1',
        ignoreCount: 0,
        diag_time: '01:00:00',
        diagRunStartedAt: minutesAgo(5),
      },
      { status: 'DIAGNOSTIC_Pause', ignoreCount: 0 },
    );
    const t = await service.getWorkTimer('S1');
    expect(t.diag).toEqual({ accumulatedMs: 3_600_000, runningSince: null });
  });

  it('Stat d’un AUTRE cycle que le courant : jamais en cours', async () => {
    await build(
      {
        _id: 'S0',
        _idDi: 'DI1',
        ignoreCount: 0,
        diag_time: '00:00:14',
        diagRunStartedAt: minutesAgo(1),
      },
      { status: 'INDIAGNOSTIC', ignoreCount: 2 },
    );
    const t = await service.getWorkTimer('S0');
    expect(t.diag.runningSince).toBeNull();
  });

  it('segment > 12 h (session abandonnée) : ancre ignorée', async () => {
    await build(
      {
        _id: 'S1',
        _idDi: 'DI1',
        ignoreCount: 0,
        rep_time: '00:30:00',
        repRunStartedAt: minutesAgo(13 * 60),
      },
      { status: 'INREPARATION', ignoreCount: 0 },
    );
    const t = await service.getWorkTimer('S1');
    expect(t.rep).toEqual({ accumulatedMs: 30 * 60_000, runningSince: null });
  });

  it('réparation EN COURS, heures ≥ 100', async () => {
    await build(
      {
        _id: 'S1',
        _idDi: 'DI1',
        ignoreCount: 0,
        rep_time: '120:00:00',
        repRunStartedAt: minutesAgo(2),
      },
      { status: 'INREPARATION', ignoreCount: 0 },
    );
    const t = await service.getWorkTimer('S1');
    expect(t.rep.accumulatedMs).toBe(120 * 3_600_000);
    expect(t.rep.runningSince).toEqual(minutesAgo(2));
  });

  it('Stat introuvable : erreur', async () => {
    await build(null, null);
    await expect(service.getWorkTimer('NOPE')).rejects.toThrow(/introuvable/);
  });
});
