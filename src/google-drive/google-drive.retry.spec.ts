import { GoogleDriveService } from './google-drive.service';
import { GoogleOAuthService } from '../google-auth/google-auth.service';
import { OAuthTokenService } from '../oauth-token/oauth-token.service';
import {
  GoogleDriveUploadError,
  GoogleOAuthGrantError,
} from '../google-auth/google-oauth.errors';

/**
 * Retry policy + auth-error mapping for Drive calls. `callWithRetry` is private;
 * we exercise it through `uploadFile` with a stubbed `ensureClient`.
 */
describe('GoogleDriveService — retry & auth-error mapping', () => {
  /** OAuth service backed by a fake token store (refresh token lives in Mongo). */
  function makeOAuth(): GoogleOAuthService {
    const tokens = {
      getRefreshToken: jest.fn(async () => 'rt'),
      getRecord: jest.fn(async () => null),
      saveRefreshToken: jest.fn(async () => undefined),
      markReauthRequired: jest.fn(async () => undefined),
      touchRefreshed: jest.fn(async () => undefined),
    };
    return new GoogleOAuthService(tokens as unknown as OAuthTokenService);
  }

  function makeSvc(createImpl: jest.Mock) {
    const svc: any = new GoogleDriveService(makeOAuth());
    // markReauthFromError is best-effort side-work on invalid_grant — stub it so
    // the retry assertions stay focused on the diagnostic being thrown.
    jest
      .spyOn(svc.oauth, 'markReauthFromError')
      .mockResolvedValue(undefined);
    svc.ensureClient = jest
      .fn()
      .mockResolvedValue({ files: { create: createImpl } });
    // Neutralize backoff waits so the test is instant.
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((cb: any) => {
        cb();
        return 0 as any;
      });
    jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    return svc;
  }

  afterEach(() => jest.restoreAllMocks());

  it('retries a transient 503 then succeeds', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({
        data: { id: 'FILE1', webViewLink: 'http://d/FILE1', name: 'f.pdf' },
      });
    const svc = makeSvc(create);
    const res = await svc.uploadFile('FOLDER', 'f.pdf', Buffer.from('x'));
    expect(res.id).toBe('FILE1');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('retries up to MAX_ATTEMPTS (3) then wraps in GoogleDriveUploadError', async () => {
    const create = jest.fn().mockRejectedValue({ response: { status: 500 } });
    const svc = makeSvc(create);
    await expect(
      svc.uploadFile('FOLDER', 'f.pdf', Buffer.from('x')),
    ).rejects.toBeInstanceOf(GoogleDriveUploadError);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry invalid_grant → throws the actionable diagnostic ONCE', async () => {
    const create = jest.fn().mockRejectedValue({
      response: { status: 400, data: { error: 'invalid_grant' } },
    });
    const svc = makeSvc(create);
    await expect(
      svc.uploadFile('FOLDER', 'f.pdf', Buffer.from('x')),
    ).rejects.toBeInstanceOf(GoogleOAuthGrantError);
    expect(create).toHaveBeenCalledTimes(1); // no retry
  });

  it('does NOT retry a 4xx (e.g. 404) → wraps once, no retry', async () => {
    const create = jest.fn().mockRejectedValue({ response: { status: 404 } });
    const svc = makeSvc(create);
    await expect(
      svc.uploadFile('FOLDER', 'f.pdf', Buffer.from('x')),
    ).rejects.toBeInstanceOf(GoogleDriveUploadError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps the service-account quota error to an actionable GoogleDriveUploadError', async () => {
    const create = jest.fn().mockRejectedValue({
      errors: [{ reason: 'storageQuotaExceeded', message: 'no quota' }],
    });
    const svc = makeSvc(create);
    await expect(
      svc.uploadFile('FOLDER', 'f.pdf', Buffer.from('x')),
    ).rejects.toMatchObject({ reason: 'storageQuotaExceeded' });
    expect(create).toHaveBeenCalledTimes(1); // quota is not transient
  });
});
