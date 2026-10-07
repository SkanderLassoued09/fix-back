import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import { OperationalErrorService } from './operational-error.service';
import { runWithRequest } from '../common/request-context';
import type { CatchReport } from '../common/error-context';

const report = (key = 'removeCompany_CompanysService_error', message = 'boom'): CatchReport => ({
  title: key.split('_')[0],
  key,
  error: { name: 'Error', message, code: null, stack: 'Error: boom' },
});

describe('OperationalErrorService.reportCatch (FIX-232)', () => {
  let discord: { sendCatchAlert: jest.Mock };
  let service: OperationalErrorService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    jest.spyOn(fs, 'appendFileSync').mockImplementation(() => undefined);
    discord = { sendCatchAlert: jest.fn().mockResolvedValue(undefined) };
    service = new OperationalErrorService(discord as any);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the report to Discord and dedups the same key + message', async () => {
    await service.reportCatch(report());
    await service.reportCatch(report());
    expect(discord.sendCatchAlert).toHaveBeenCalledTimes(1);
    expect(discord.sendCatchAlert).toHaveBeenCalledWith(report());
    await service.reportCatch(report(undefined, 'other message'));
    expect(discord.sendCatchAlert).toHaveBeenCalledTimes(2);
  });

  it('skips QA traffic (x-test-run: 1)', async () => {
    await runWithRequest({ headers: { 'x-test-run': '1' } }, () =>
      service.reportCatch(report()),
    );
    expect(discord.sendCatchAlert).not.toHaveBeenCalled();
  });

  it('never reports its own reporting path (no recursion)', async () => {
    await service.reportCatch(report('sendCatchAlert_DiscordHookService_error'));
    expect(discord.sendCatchAlert).not.toHaveBeenCalled();
  });

  it('never throws when Discord fails', async () => {
    discord.sendCatchAlert.mockRejectedValue(new Error('discord down'));
    await expect(service.reportCatch(report())).resolves.toBeUndefined();
  });
});
