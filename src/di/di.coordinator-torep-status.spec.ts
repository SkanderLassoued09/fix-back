// DiService pulls in `nanoid` (ESM-only); stub it so ts-jest can load it.
jest.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { DiService } from './di.service';
import { STATUS_DI } from './di.status';

/**
 * Regression for the `di.service.ts:1493` bug: `coordinator_ToRep` used to write
 * `status: STATUS_DI.Reparation` (the whole CONFIG OBJECT) instead of
 * `STATUS_DI.Reparation.status` ('REPARATION'). Because the `statusHistory`
 * Mongoose hook appends `{ status: <$set.status> }`, the object form corrupted
 * the transition history. The fix must write the string VALUE.
 */
function makeSvc() {
  const svc: any = Object.create(DiService.prototype);
  const reparation = {
    _id: 'DI1',
    ignoreCount: 0,
    status: STATUS_DI.Reparation.status,
  };
  svc.diModel = {
    findOneAndUpdate: jest.fn().mockResolvedValue(reparation),
    countDocuments: jest.fn().mockResolvedValue(1),
  };
  svc.statsService = { updateStatus: jest.fn().mockResolvedValue(undefined) };
  svc.discordHookService = {
    sendReparationAssigned: jest.fn().mockResolvedValue(undefined),
  };
  svc.captureDiscordFailure = jest.fn();
  return svc;
}

describe('DiService.coordinator_ToRep — statusHistory value (bug :1493)', () => {
  it('writes the status VALUE "REPARATION", never the STATUS_DI config object', async () => {
    const svc = makeSvc();
    await svc.coordinator_ToRep('DI1', 'tech1');

    const [, update] = svc.diModel.findOneAndUpdate.mock.calls[0];
    // The hook appends { status: <$set.status> } → it MUST be the string value.
    expect(update.$set.status).toBe('REPARATION');
    expect(update.$set.status).toBe(STATUS_DI.Reparation.status);
    expect(typeof update.$set.status).toBe('string');
    // Regression guard: never the whole object again.
    expect(update.$set.status).not.toEqual(STATUS_DI.Reparation);
  });
});
