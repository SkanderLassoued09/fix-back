import { GoogleDriveService } from './google-drive.service';
import { GoogleOAuthService } from '../google-auth/google-auth.service';
import { OAuthTokenService } from '../oauth-token/oauth-token.service';

/**
 * Fake token store (the refresh token lives in Mongo now). `token` is the
 * in-memory value `getRefreshToken` serves; flip it to null for "not authorized".
 */
function makeOAuth(token: string | null = 'rt'): GoogleOAuthService {
  const state = { token };
  const tokens = {
    getRefreshToken: jest.fn(async () => state.token),
    getRecord: jest.fn(async () => null),
    saveRefreshToken: jest.fn(async (rt: string) => {
      state.token = rt;
    }),
    markReauthRequired: jest.fn(async () => undefined),
    touchRefreshed: jest.fn(async () => undefined),
  };
  const svc = new GoogleOAuthService(tokens as unknown as OAuthTokenService);
  (svc as any).__tokenState = state; // exposed so a test can flip it
  return svc;
}

/**
 * Unit tests for the parts that DON'T need a live Drive (naming + sanitization).
 * Live folder creation / upload require the external Shared-Drive prerequisites
 * and are validated separately by the user.
 */
describe('GoogleDriveService — naming & sanitization', () => {
  const oauth = makeOAuth('rt');
  const svc = new GoogleDriveService(oauth);
  // Fixed instant: 2026-06-18 10:30:45 UTC → 11:30:45 in Africa/Tunis (UTC+1).
  const at = new Date('2026-06-18T10:30:45.000Z');

  beforeAll(() => {
    process.env.APP_TIMEZONE = 'Africa/Tunis';
  });

  it('builds {Name}_{DocType}_{DD-MM-YYYY}_{HH-mm-ss}.{ext} in Africa/Tunis', () => {
    expect(svc.buildDocFileName('Excubia Skander', 'BL', 'pdf', at)).toBe(
      'ExcubiaSkander_BL_18-06-2026_11-30-45.pdf',
    );
  });

  it('uses the same scheme for every DocType, images included', () => {
    expect(svc.buildDocFileName('Acme', 'BC', 'pdf', at)).toBe(
      'Acme_BC_18-06-2026_11-30-45.pdf',
    );
    expect(svc.buildDocFileName('Acme', 'Devis', 'pdf', at)).toBe(
      'Acme_Devis_18-06-2026_11-30-45.pdf',
    );
    expect(svc.buildDocFileName('Acme', 'Facture', 'pdf', at)).toBe(
      'Acme_Facture_18-06-2026_11-30-45.pdf',
    );
    expect(svc.buildDocFileName('Acme', 'FicheTechnique', 'pdf', at)).toBe(
      'Acme_FicheTechnique_18-06-2026_11-30-45.pdf',
    );
    expect(svc.buildDocFileName('Acme', 'Image', 'png', at)).toBe(
      'Acme_Image_18-06-2026_11-30-45.png',
    );
  });

  it('preserves the real extension (lower-cased, alnum only)', () => {
    expect(svc.buildDocFileName('Acme', 'Image', 'JPEG', at)).toBe(
      'Acme_Image_18-06-2026_11-30-45.jpeg',
    );
    expect(svc.buildDocFileName('Acme', 'BC', 'docx', at)).toBe(
      'Acme_BC_18-06-2026_11-30-45.docx',
    );
  });

  it('makes the {Name} part Drive/desktop-safe: drops accents, spaces, illegal chars', () => {
    expect(svc.buildDocFileName('Sté Béta / X*?', 'BC', 'pdf', at)).toBe(
      'SteBetaX_BC_18-06-2026_11-30-45.pdf',
    );
  });

  it('falls back to a default name part when empty', () => {
    expect(svc.buildDocFileName('   ', 'BC', 'pdf', at)).toBe(
      'Doc_BC_18-06-2026_11-30-45.pdf',
    );
  });

  it('container helper keeps names readable (spaces kept, illegal stripped)', () => {
    expect(svc.sanitizeFolderName('Acme / Co : *')).toBe('Acme Co');
    expect(svc.sanitizeFolderName('   ')).toBe('Entity');
  });

  it('entity folder name = {Name}_{DD-MM-YYYY}_{HH-mm-ss} (creation time, Tunis)', () => {
    expect(svc.buildEntityFolderName('Excubia Skander', at)).toBe(
      'ExcubiaSkander_18-06-2026_11-30-45',
    );
  });

  it('entity folder name cleans accents/spaces/illegal chars in the {Name} part', () => {
    expect(svc.buildEntityFolderName('Sté Béta / X*?', at)).toBe(
      'SteBetaX_18-06-2026_11-30-45',
    );
    expect(svc.buildEntityFolderName('   ', at)).toBe(
      'Doc_18-06-2026_11-30-45',
    );
  });

  // Bug: duplicate `CLIENTS/client/{Name}_*` folders appeared on every new DI.
  // Now ensureEntityFolder looks up by `{SanitizedName}_` prefix first and
  // reuses any existing folder; only creates when none exists. Same entity =>
  // same prefix => same folder, regardless of how many times callers fire OR
  // whether `createdAt` reproduces the original timestamp.
  describe('ensureEntityFolder — find-by-prefix or create (no duplicate folders)', () => {
    function makeSvc(
      findMatches: Array<Array<{ id: string; webViewLink: string }>>,
    ): {
      svc: any;
      findFoldersByNamePrefix: jest.Mock;
      createSubFolder: jest.Mock;
    } {
      const svc: any = new GoogleDriveService(makeOAuth('rt'));
      const findFoldersByNamePrefix = jest.fn();
      for (const m of findMatches)
        findFoldersByNamePrefix.mockResolvedValueOnce(m);
      const createSubFolder = jest
        .fn()
        .mockResolvedValue({ id: 'NEW', webViewLink: 'http://drive/NEW' });
      // Stub the IO surface — only the find-or-create branch matters here.
      svc.ensureClient = jest.fn().mockResolvedValue({});
      svc.ensureTypeContainer = jest.fn().mockResolvedValue('PARENT');
      svc.findFoldersByNamePrefix = findFoldersByNamePrefix;
      svc.createSubFolder = createSubFolder;
      return { svc, findFoldersByNamePrefix, createSubFolder };
    }

    const at = new Date('2026-06-18T10:30:45.000Z');

    it('REUSES an existing folder found by {Name}_ prefix (timestamp may differ)', async () => {
      const { svc, findFoldersByNamePrefix, createSubFolder } = makeSvc([
        [{ id: 'EXISTING', webViewLink: 'http://drive/EXISTING' }],
      ]);
      const folder = await svc.ensureEntityFolder('client', 'Skander L', at);
      expect(folder.id).toBe('EXISTING');
      // Sanitized prefix passed (spaces dropped, no timestamp).
      expect(findFoldersByNamePrefix).toHaveBeenCalledWith(
        expect.anything(),
        'SkanderL',
        'PARENT',
      );
      expect(createSubFolder).not.toHaveBeenCalled();
    });

    it('CREATES the folder when no match exists', async () => {
      const { svc, findFoldersByNamePrefix, createSubFolder } = makeSvc([[]]);
      const folder = await svc.ensureEntityFolder('client', 'Skander L', at);
      expect(folder.id).toBe('NEW');
      expect(findFoldersByNamePrefix).toHaveBeenCalledTimes(1);
      expect(createSubFolder).toHaveBeenCalledTimes(1);
    });

    it('MULTIPLE matches → returns OLDEST (first), logs duplicates', async () => {
      const warn = jest
        .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      // findFoldersByNamePrefix returns ordered ASC by createdTime → [0] is oldest.
      const { svc, createSubFolder } = makeSvc([
        [
          { id: 'OLDEST', webViewLink: 'http://drive/OLDEST' },
          { id: 'DUP1', webViewLink: 'http://drive/DUP1' },
          { id: 'DUP2', webViewLink: 'http://drive/DUP2' },
        ],
      ]);
      const folder = await svc.ensureEntityFolder('client', 'Skander L', at);
      expect(folder.id).toBe('OLDEST');
      expect(createSubFolder).not.toHaveBeenCalled();
      // Warn cites the count + the duplicates' ids — best-effort visibility,
      // we don't auto-delete them.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('3 folders'),
      );
      expect(warn.mock.calls[0][0]).toContain('DUP1');
      expect(warn.mock.calls[0][0]).toContain('DUP2');
      warn.mockRestore();
    });

    it('idempotent: 3 sequential calls with same name → 1 create, 2 reuses', async () => {
      // 1st call: not found → creates. 2nd & 3rd: now found → reuse.
      const { svc, findFoldersByNamePrefix, createSubFolder } = makeSvc([
        [],
        [{ id: 'NEW', webViewLink: 'http://drive/NEW' }],
        [{ id: 'NEW', webViewLink: 'http://drive/NEW' }],
      ]);
      const r1 = await svc.ensureEntityFolder('client', 'A B', at);
      const r2 = await svc.ensureEntityFolder('client', 'A B', at);
      const r3 = await svc.ensureEntityFolder('client', 'A B', at);
      expect([r1.id, r2.id, r3.id]).toEqual(['NEW', 'NEW', 'NEW']);
      expect(findFoldersByNamePrefix).toHaveBeenCalledTimes(3);
      expect(createSubFolder).toHaveBeenCalledTimes(1);
    });

    it('prefix is the sanitized {Name}: accents/spaces/illegal chars dropped', async () => {
      const { svc, findFoldersByNamePrefix } = makeSvc([
        [{ id: 'X', webViewLink: 'http://drive/X' }],
      ]);
      await svc.ensureEntityFolder('company', 'Sté Béta / X*?', at);
      expect(findFoldersByNamePrefix).toHaveBeenCalledWith(
        expect.anything(),
        'SteBetaX',
        'PARENT',
      );
    });
  });

  // The previous `/file not found|not found/i` regex caught any error message
  // containing "not found" anywhere, mis-classifying unrelated upload failures
  // as 404s and triggering forceRecreate → a path that produced duplicate
  // entity folders. The tightened predicate only matches Drive's canonical
  // 404 shape (numeric code, `notFound` reason, or `^File not found`).
  describe('isNotFoundError — narrowed scope (no false-positive forceRecreate)', () => {
    const svc = new GoogleDriveService(makeOAuth('rt'));

    it('matches numeric code 404', () => {
      expect(svc.isNotFoundError({ code: 404 })).toBe(true);
      expect(svc.isNotFoundError({ response: { status: 404 } })).toBe(true);
    });

    it('matches reason "notFound"', () => {
      expect(svc.isNotFoundError({ errors: [{ reason: 'notFound' }] })).toBe(true);
      expect(svc.isNotFoundError({ reason: 'notFound' })).toBe(true);
    });

    it('matches canonical Drive message "File not found: {id}"', () => {
      expect(
        svc.isNotFoundError(new Error('File not found: 1AbCdEfGh123')),
      ).toBe(true);
    });

    it('does NOT match arbitrary errors mentioning "not found" elsewhere', () => {
      // The previous broad regex flagged ALL of these as 404 → forceRecreate.
      expect(
        svc.isNotFoundError(new Error('User token not found in cache')),
      ).toBe(false);
      expect(
        svc.isNotFoundError(new Error('Quota: refresh token not found')),
      ).toBe(false);
      expect(svc.isNotFoundError(new Error('parent folder not found here'))).toBe(
        false,
      );
      expect(svc.isNotFoundError(new Error('quota exceeded'))).toBe(false);
    });
  });

  it('isConfigured needs OAuth app creds (env) + a stored refresh token (DB); parent folder is OPTIONAL', async () => {
    const keys = [
      'GOOGLE_DRIVE_PARENT_FOLDER_ID',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    keys.forEach((k) => delete process.env[k]);

    // Start un-authorized (no stored token) + no app creds.
    const noToken = new GoogleDriveService(makeOAuth(null));
    await expect(noToken.isConfigured()).resolves.toBe(false);

    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    // App creds present but STILL no stored token → not configured yet.
    await expect(noToken.isConfigured()).resolves.toBe(false);

    // A token stored in the DB → configured WITHOUT a parent folder (the app
    // creates CLIENTS itself).
    const withToken = new GoogleDriveService(makeOAuth('rt'));
    await expect(withToken.isConfigured()).resolves.toBe(true);

    // restore
    keys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    });
  });
});
