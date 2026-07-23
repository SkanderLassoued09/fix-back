import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { StatService } from './stat.service';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';
import { LogsDiService } from 'src/logs-di/logs-di.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';

/**
 * Segments de travail diagnostic — cumul CÔTÉ SERVEUR (facturation).
 *
 * Invariants :
 *  - openDiagLeg ne stampe que si AUCUN segment n'est ouvert (idempotent) ;
 *  - closeDiagLeg cumule `diag_time += now − diagRunStartedAt`, journalise le
 *    segment {startedAt, stoppedAt} et vide l'ancre — atomiquement (filtre sur
 *    la même ancre) ; no-op sans segment ouvert (double pause) ;
 *  - jamais deux segments ouverts (l'ancre est le SEUL segment ouvert) ;
 *  - lapTime (valeur envoyée par le client) N'ÉCRIT PLUS diag_time — le temps
 *    facturé ne peut pas être manipulé ni gelé par le throttling d'onglet.
 */
type StatModelMock = {
  updateOne: jest.Mock;
  findOne: jest.Mock;
};

describe('StatService — diagnostic work legs (server-side accumulation)', () => {
  let service: StatService;
  let statModel: StatModelMock;

  beforeEach(async () => {
    statModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      findOne: jest.fn(),
    };
    const anyModel = { findOne: jest.fn(), updateOne: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StatService,
        { provide: getModelToken('Stat'), useValue: statModel },
        { provide: getModelToken('Di'), useValue: anyModel },
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
  });

  afterEach(() => jest.useRealTimers());

  describe('openDiagLeg', () => {
    it('stamps the anchor ONLY when no leg is open (filter diagRunStartedAt: null)', async () => {
      await service.openDiagLeg('DI-1');
      const [filter, update] = statModel.updateOne.mock.calls[0];
      expect(filter).toEqual({ _idDi: 'DI-1', diagRunStartedAt: null });
      expect(update.$set.diagRunStartedAt).toBeInstanceOf(Date);
    });

    it('scopes by ignoreCount on RETOUR cycles', async () => {
      await service.openDiagLeg('DI-1', 2);
      expect(statModel.updateOne.mock.calls[0][0]).toEqual({
        _idDi: 'DI-1',
        ignoreCount: 2,
        diagRunStartedAt: null,
      });
    });

    it('double start: reports no-op when a leg is already open (no anchor move)', async () => {
      statModel.updateOne.mockResolvedValue({ modifiedCount: 0 });
      await expect(service.openDiagLeg('DI-1')).resolves.toBe(false);
    });
  });

  describe('closeDiagLeg', () => {
    it('folds (now − anchor) into diag_time, pushes the segment, clears the anchor', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-22T10:00:30Z'));
      const startedAt = new Date('2026-07-22T10:00:00Z'); // leg de 30 s
      statModel.findOne.mockResolvedValue({
        _id: 'Stat-1',
        diag_time: '00:10:00',
        diagRunStartedAt: startedAt,
      });

      const total = await service.closeDiagLeg('DI-1');

      expect(total).toBe('00:10:30'); // 10 min accumulées + 30 s de segment
      const [filter, update] = statModel.updateOne.mock.calls[0];
      // Atomicité : re-filtre sur la MÊME ancre lue.
      expect(filter).toEqual({ _id: 'Stat-1', diagRunStartedAt: startedAt });
      expect(update.$set).toEqual({
        diag_time: '00:10:30',
        diagRunStartedAt: null,
      });
      expect(update.$push.diagSegments.startedAt).toEqual(startedAt);
      expect(update.$push.diagSegments.stoppedAt).toEqual(
        new Date('2026-07-22T10:00:30Z'),
      );
    });

    it('double pause: no-op when no leg is open (anchor null)', async () => {
      statModel.findOne.mockResolvedValue({
        _id: 'Stat-1',
        diag_time: '00:10:00',
        diagRunStartedAt: null,
      });
      await expect(service.closeDiagLeg('DI-1')).resolves.toBeNull();
      expect(statModel.updateOne).not.toHaveBeenCalled();
    });

    it('missing stat: no-op (never throws mid-transition)', async () => {
      statModel.findOne.mockResolvedValue(null);
      await expect(service.closeDiagLeg('DI-ghost')).resolves.toBeNull();
    });

    it('concurrent close: returns null when the anchored update matched nothing', async () => {
      statModel.findOne.mockResolvedValue({
        _id: 'Stat-1',
        diag_time: '00:10:00',
        diagRunStartedAt: new Date('2026-07-22T10:00:00Z'),
      });
      statModel.updateOne.mockResolvedValue({ modifiedCount: 0 });
      await expect(service.closeDiagLeg('DI-1')).resolves.toBeNull();
    });

    it('legacy/empty diag_time is treated as 0 (no NaN)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-22T10:00:10Z'));
      statModel.findOne.mockResolvedValue({
        _id: 'Stat-1',
        diag_time: '',
        diagRunStartedAt: new Date('2026-07-22T10:00:00Z'),
      });
      await expect(service.closeDiagLeg('DI-1')).resolves.toBe('00:00:10');
    });

    it('total = base + segment courant, y compris au-delà de 99 h (pas de troncature)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-24T10:00:00Z'));
      statModel.findOne.mockResolvedValue({
        _id: 'Stat-1',
        diag_time: '99:59:30',
        diagRunStartedAt: new Date('2026-07-24T09:59:00Z'), // +60 s
      });
      await expect(service.closeDiagLeg('DI-1')).resolves.toBe('100:00:30');
    });
  });

  describe('lapTime (client-sent duration) — neutralized', () => {
    it('does NOT write diag_time anymore (server value is authoritative for billing)', async () => {
      statModel.findOne.mockResolvedValue({
        _id: 'Stat-1',
        diag_time: '00:10:00',
      });
      const res = await service.lapTime('Stat-1', '55:55:55');
      expect(res).toBeTruthy(); // le resolver renvoie !!res (compat Boolean)
      expect(statModel.updateOne).not.toHaveBeenCalled();
    });

    it('still throws on unknown stat (legacy contract)', async () => {
      statModel.findOne.mockResolvedValue(null);
      await expect(service.lapTime('ghost', '00:00:01')).rejects.toThrow(
        'Issue in lapTime',
      );
    });
  });
});
