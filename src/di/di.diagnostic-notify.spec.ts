// DiService pulls in `nanoid` (ESM-only) via its import graph; stub it so
// ts-jest can load the module. Irrelevant to these tests.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { StatService } from 'src/stat/stat.service';

/**
 * Diagnostic assignment fires exactly ONE, complete Discord notification.
 *
 * Before: assigning a DI to diagnostic ran two mutations —
 *   createStat → sendDiAssignedToTech  (premature: DI still PENDING1, and it
 *                                       spread a Mongoose doc → N/A fields)
 *   coordinator_ToDiag → sendDiagnosticAssigned (complete, real data)
 * → two embeds at the same instant, the first full of N/A.
 *
 * After: createStat sends NOTHING; coordinator_ToDiag sends the single complete
 * embed (real DI number/title/client + the assigned technician).
 */

describe('Diagnostic assignment — single complete Discord notification', () => {
  describe('StatService.createStat no longer sends a Discord embed', () => {
    it('does NOT call sendDiAssignedToTech (the premature/N-A one is gone)', async () => {
      const svc: any = Object.create(StatService.prototype);
      svc.generateStatId = jest.fn().mockResolvedValue(1);
      svc.diModel = {
        findOne: jest.fn().mockResolvedValue({
          _id: 'DI1',
          _idnum: 'T277',
          title: 'skander',
          status: 'PENDING1',
          ignoreCount: 0,
        }),
      };
      svc.StatModel = jest
        .fn()
        .mockImplementation(() => ({
          save: jest.fn().mockResolvedValue({ _id: 's1', id_tech_diag: 'u1' }),
        }));
      svc.StatModel.findOne = jest
        .fn()
        .mockResolvedValue({ toObject: () => ({ _id: 's1', id_tech_diag: 'u1' }) });
      svc.profileService = {
        findProlileById: jest.fn().mockResolvedValue({ _id: 'u1', firstName: 'tech' }),
      };
      svc.discordHookService = { sendDiAssignedToTech: jest.fn() };
      svc.notificationGateway = { updateTicket: jest.fn() };
      svc.operationalErrorService = { capture: jest.fn() };

      await svc.createStat({ _idDi: 'DI1', id_tech_diag: 'u1' });

      expect(svc.discordHookService.sendDiAssignedToTech).not.toHaveBeenCalled();
      // The realtime socket refresh is unrelated and must stay.
      expect(svc.notificationGateway.updateTicket).toHaveBeenCalledTimes(1);
    });
  });

  describe('DiService.coordinator_ToDiag sends the single complete embed', () => {
    function makeSvc(discord: any) {
      const svc: any = Object.create(DiService.prototype);
      svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
      svc.diModel = {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          _id: 'DI1',
          _idnum: 'T277',
          title: 'skander',
          company_id: 'c1',
          status: 'DIAGNOSTIC',
          ignoreCount: 0,
        }),
      };
      svc.statsService = {
        updateStatus: jest.fn().mockResolvedValue(undefined),
        findUserLinkedToConcernedDi: jest
          .fn()
          .mockResolvedValue({ id_tech_diag: 'u1' }),
      };
      svc.discordHookService = discord;
      svc.captureDiscordFailure = jest.fn();
      return svc;
    }

    it('calls sendDiagnosticAssigned exactly ONCE with real data + technician', async () => {
      const discord = { sendDiagnosticAssigned: jest.fn().mockResolvedValue(undefined) };
      const svc = makeSvc(discord);

      await svc.coordinator_ToDiag('DI1');

      expect(discord.sendDiagnosticAssigned).toHaveBeenCalledTimes(1);
      const [diArg, techArg] = discord.sendDiagnosticAssigned.mock.calls[0];
      // Real DI data (never N/A) + the resolved technician id.
      expect(diArg).toEqual(
        expect.objectContaining({ _idnum: 'T277', title: 'skander' }),
      );
      expect(techArg).toBe('u1');
    });

    it('still returns the DI even if the technician lookup fails (best-effort)', async () => {
      const discord = { sendDiagnosticAssigned: jest.fn().mockResolvedValue(undefined) };
      const svc = makeSvc(discord);
      svc.statsService.findUserLinkedToConcernedDi = jest
        .fn()
        .mockRejectedValue(new Error('no stat'));

      const res = await svc.coordinator_ToDiag('DI1');

      expect(res).toEqual(expect.objectContaining({ _idnum: 'T277' }));
      expect(discord.sendDiagnosticAssigned).toHaveBeenCalledTimes(1);
      expect(discord.sendDiagnosticAssigned.mock.calls[0][1]).toBeNull();
    });
  });
});
