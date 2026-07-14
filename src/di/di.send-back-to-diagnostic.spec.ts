// DiService pulls in `nanoid` (ESM-only) through its import graph; stub it so
// ts-jest can load the module.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { assertDiTransition } from './workflow/di-transition-guard';

/**
 * « Renvoyer au diagnostic » — the admin, while pricing a (typically
 * non-repairable) DI, bounces it back to the coordinator so a technician is
 * re-assigned: PRICING → PENDING1.
 */
describe('Renvoyer au diagnostic — PRICING → PENDING1', () => {
  describe('transition guard', () => {
    it('ALLOWS PRICING → PENDING1 (the new arc)', () => {
      expect(() => assertDiTransition('PRICING', 'PENDING1')).not.toThrow();
    });

    it('still ALLOWS the original CREATED → PENDING1', () => {
      expect(() => assertDiTransition('CREATED', 'PENDING1')).not.toThrow();
    });

    it('REFUSES PENDING2 → PENDING1 (not a valid source)', () => {
      expect(() => assertDiTransition('PENDING2', 'PENDING1')).toThrow();
    });

    it('REFUSES INDIAGNOSTIC → PENDING1 (no accidental back-jump)', () => {
      expect(() => assertDiTransition('INDIAGNOSTIC', 'PENDING1')).toThrow();
    });
  });

  describe('DiService.sendDiBackToDiagnostic', () => {
    function makeSvc(ignoreCount = 0, canRepair: boolean | null = false) {
      const svc: any = Object.create(DiService.prototype);
      svc.assertTransitionAllowed = jest.fn().mockResolvedValue(undefined);
      svc.diModel = {
        // Guard read: only a non-repairable DI may be sent back.
        findOne: jest.fn().mockReturnValue({
          select: () => ({
            lean: () => Promise.resolve({ can_be_repaired: canRepair }),
          }),
        }),
        findOneAndUpdate: jest
          .fn()
          .mockResolvedValue({ _id: 'DI1', status: 'PENDING1', ignoreCount }),
      };
      svc.statsService = {
        updateStatus: jest.fn().mockResolvedValue(undefined),
      };
      return svc;
    }

    it('moves the DI to PENDING1 and syncs the Stat', async () => {
      const svc = makeSvc(0);
      const res = await svc.sendDiBackToDiagnostic('DI1');
      expect(svc.assertTransitionAllowed).toHaveBeenCalledWith(
        'DI1',
        'PENDING1',
      );
      expect(res.status).toBe('PENDING1');
      expect(svc.statsService.updateStatus).toHaveBeenCalledWith(
        'DI1',
        'PENDING1',
      );
    });

    it('forwards ignoreCount to updateStatus on a retour DI', async () => {
      const svc = makeSvc(2);
      await svc.sendDiBackToDiagnostic('DI1');
      expect(svc.statsService.updateStatus).toHaveBeenCalledWith(
        'DI1',
        'PENDING1',
        2,
      );
    });

    it('REFUSES a REPARABLE DI (normal pricing path) — never transitions', async () => {
      const svc = makeSvc(0, true); // can_be_repaired: true
      await expect(svc.sendDiBackToDiagnostic('DI1')).rejects.toMatchObject({
        extensions: { code: 'BACK_TO_DIAG_NOT_NON_REPARABLE' },
      });
      expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(svc.statsService.updateStatus).not.toHaveBeenCalled();
    });
  });
});
