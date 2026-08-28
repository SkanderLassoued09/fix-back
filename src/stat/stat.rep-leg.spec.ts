import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { StatService } from './stat.service';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';
import { LogsDiService } from 'src/logs-di/logs-di.service';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';

/**
 * Segments de travail RÉPARATION — cumul CÔTÉ SERVEUR.
 *
 * Jumeau de `stat.diag-leg.spec.ts`. Avant `closeRepLeg`, la réparation n'avait
 * AUCUN cumul serveur : `repRunStartedAt` était posé au démarrage et jamais
 * vidé, ni à la pause ni à la fin. Une DI rouverte des jours plus tard
 * recalculait `rep_time + (now − ancre périmée)` et affichait des centaines
 * d'heures — c'est l'origine des durées absurdes signalées côté UI.
 *
 * Invariants vérifiés :
 *  - cumul `rep_time += now − repRunStartedAt`, segment journalisé, ancre vidée ;
 *  - no-op sans segment ouvert (double pause) ;
 *  - atomicité : le filtre d'update re-vérifie l'ANCRE LUE (anti double-cumul) ;
 *  - format canonique HH:MM:SS avec HH pouvant dépasser 99 ;
 *  - `lapTimeForReaparation` REFUSE une valeur malformée (rempart d'écriture).
 */
type StatModelMock = { updateOne: jest.Mock; findOne: jest.Mock };

describe('StatService — repair work legs (server-side accumulation)', () => {
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

  describe('closeRepLeg', () => {
    it('cumule le segment dans rep_time, le journalise et VIDE l’ancre', async () => {
      const startedAt = new Date('2026-08-27T10:00:00.000Z');
      jest.useFakeTimers().setSystemTime(new Date('2026-08-27T10:00:30.000Z'));
      statModel.findOne.mockResolvedValue({
        _id: 'STAT-1',
        rep_time: '00:01:00',
        repRunStartedAt: startedAt,
      });

      const out = await service.closeRepLeg('DI-1');

      expect(out).toBe('00:01:30'); // 1 min déjà cumulée + 30 s de segment
      expect(statModel.updateOne).toHaveBeenCalledWith(
        // Re-filtre sur la MÊME ancre → anti double-cumul concurrent.
        { _id: 'STAT-1', repRunStartedAt: startedAt },
        {
          $set: { rep_time: '00:01:30', repRunStartedAt: null },
          $push: { repSegments: { startedAt, stoppedAt: new Date() } },
        },
      );
    });

    it('no-op quand aucun segment n’est ouvert (double pause)', async () => {
      statModel.findOne.mockResolvedValue({
        _id: 'STAT-1',
        rep_time: '00:05:00',
        repRunStartedAt: null,
      });

      expect(await service.closeRepLeg('DI-1')).toBeNull();
      expect(statModel.updateOne).not.toHaveBeenCalled();
    });

    it('no-op quand la Stat n’existe pas', async () => {
      statModel.findOne.mockResolvedValue(null);
      expect(await service.closeRepLeg('DI-1')).toBeNull();
      expect(statModel.updateOne).not.toHaveBeenCalled();
    });

    it('renvoie null si un appel concurrent a déjà fermé le segment', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-27T10:00:30.000Z'));
      statModel.findOne.mockResolvedValue({
        _id: 'STAT-1',
        rep_time: '00:00:00',
        repRunStartedAt: new Date('2026-08-27T10:00:00.000Z'),
      });
      statModel.updateOne.mockResolvedValue({ modifiedCount: 0 }); // filtre non matché

      expect(await service.closeRepLeg('DI-1')).toBeNull();
    });

    it('cible le bon cycle en RETOUR (ignoreCount)', async () => {
      statModel.findOne.mockResolvedValue(null);
      await service.closeRepLeg('DI-1', 2);
      expect(statModel.findOne).toHaveBeenCalledWith({
        _idDi: 'DI-1',
        ignoreCount: 2,
      });
    });

    it('produit des heures à 3 chiffres sans les tronquer (HH > 99)', async () => {
      const startedAt = new Date('2026-08-27T10:00:00.000Z');
      jest.useFakeTimers().setSystemTime(new Date('2026-08-27T10:00:30.000Z'));
      statModel.findOne.mockResolvedValue({
        _id: 'STAT-1',
        rep_time: '100:00:00',
        repRunStartedAt: startedAt,
      });

      expect(await service.closeRepLeg('DI-1')).toBe('100:00:30');
    });
  });

  describe('lapTimeForReaparation — rempart d’écriture', () => {
    it('REFUSE une valeur malformée et n’écrit rien', async () => {
      await expect(
        service.lapTimeForReaparation('STAT-1', '777.65.6h'),
      ).rejects.toThrow(/rep_time invalide/);
      expect(statModel.updateOne).not.toHaveBeenCalled();
      expect(statModel.findOne).not.toHaveBeenCalled();
    });

    it('REFUSE la chaîne « undefined » (corruption observée en base)', async () => {
      await expect(
        service.lapTimeForReaparation('STAT-1', 'undefined'),
      ).rejects.toThrow(/rep_time invalide/);
      expect(statModel.updateOne).not.toHaveBeenCalled();
    });

    it('ACCEPTE un format canonique, y compris HH > 99', async () => {
      statModel.findOne.mockResolvedValue({ _id: 'STAT-1', ignoreCount: 0 });
      await service.lapTimeForReaparation('STAT-1', '100:00:30');
      expect(statModel.updateOne).toHaveBeenCalledWith(
        { _id: 'STAT-1' },
        { $set: { rep_time: '100:00:30' } },
      );
    });
  });
});
