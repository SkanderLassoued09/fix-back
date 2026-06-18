import { GoogleDriveService } from './google-drive.service';

/**
 * Unit tests for the parts that DON'T need a live Drive (naming + sanitization).
 * Live folder creation / upload require the external Shared-Drive prerequisites
 * and are validated separately by the user.
 */
describe('GoogleDriveService — naming & sanitization', () => {
  const svc = new GoogleDriveService();
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

  it('isConfigured needs OAuth client + refresh token (parent folder is OPTIONAL)', () => {
    const keys = [
      'GOOGLE_DRIVE_PARENT_FOLDER_ID',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_OAUTH_REFRESH_TOKEN',
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    keys.forEach((k) => delete process.env[k]);
    expect(svc.isConfigured()).toBe(false);
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    // still missing the refresh token → not configured yet
    expect(svc.isConfigured()).toBe(false);
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'rt';
    // configured WITHOUT a parent folder — the app creates CLIENTS itself
    expect(svc.isConfigured()).toBe(true);
    // restore
    keys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    });
  });
});
