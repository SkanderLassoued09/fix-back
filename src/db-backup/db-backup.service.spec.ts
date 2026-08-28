import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DbBackupService } from './db-backup.service';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import { DiscordHookService } from '../discord-hook/discord-hook.service';

/**
 * Unit tests for BACKUP_DB_TO_DRIVE. `mongodump` and Google Drive are BOTH
 * mocked: `runMongodump` is overridden by a subclass (it is `protected` for
 * exactly this reason) and writes a fake archive, so the real pipeline —
 * size check, folder resolution, upload, retention, cleanup, alerting — runs
 * end to end against the real filesystem without a database or a network call.
 */

/** Test double for the ONLY four Drive methods this service uses. */
function makeDrive(overrides: Partial<Record<string, any>> = {}) {
  return {
    isConfigured: jest.fn(async () => true),
    ensureNamedContainer: jest.fn(async (name: string) => `folder-of-${name}`),
    uploadFile: jest.fn(async (_folderId, fileName) => ({
      id: 'drive-file-1',
      webViewLink: 'https://drive.example/file',
      name: fileName,
    })),
    listFilesInFolder: jest.fn(async () => []),
    deleteFile: jest.fn(async () => undefined),
    getFilePermissions: jest.fn(async () => ({
      isPublic: false,
      permissions: [{ id: 'p1', type: 'user', role: 'owner' }],
    })),
    ...overrides,
  } as unknown as GoogleDriveService;
}

function makeDiscord() {
  return {
    sendDbBackupSuccess: jest.fn(async () => undefined),
    sendDbBackupFailure: jest.fn(async () => undefined),
  } as unknown as DiscordHookService;
}

/** Subclass replacing the real `mongodump` with a controllable fake. */
class TestableDbBackupService extends DbBackupService {
  /** Bytes the fake dump writes; `null` = write no file at all. */
  fakeDumpBytes: number | null = 1024;
  /** When set, the fake dump rejects with this error instead of writing. */
  dumpError: Error | null = null;
  dumpCalls: Array<{ uri: string; archivePath: string }> = [];

  protected async runMongodump(
    uri: string,
    archivePath: string,
  ): Promise<void> {
    this.dumpCalls.push({ uri, archivePath });
    if (this.dumpError) throw this.dumpError;
    if (this.fakeDumpBytes === null) return; // exits 0 but produces nothing
    fs.writeFileSync(archivePath, Buffer.alloc(this.fakeDumpBytes, 1));
  }
}

describe('DbBackupService — BACKUP_DB_TO_DRIVE', () => {
  const ENV_KEYS = [
    'NODE_ENV',
    'MONGODB_URI',
    'APP_TIMEZONE',
    'DB_BACKUP_FOLDER_ID',
    'DB_BACKUP_FOLDER_NAME',
    'DB_BACKUP_RETENTION',
    'DB_BACKUP_TMP_DIR',
  ];
  let saved: Record<string, string | undefined>;
  let tmpDir: string;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixtronix-backup-test-'));
    process.env.NODE_ENV = 'production';
    process.env.APP_TIMEZONE = 'Africa/Tunis';
    process.env.MONGODB_URI = 'mongodb://localhost:27017/fixtronixproddb';
    process.env.DB_BACKUP_TMP_DIR = tmpDir;
    delete process.env.DB_BACKUP_FOLDER_ID;
    delete process.env.DB_BACKUP_FOLDER_NAME;
    delete process.env.DB_BACKUP_RETENTION;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── File name (Africa/Tunis) ────────────────────────────────────────────
  describe('buildBackupFileName', () => {
    it('produces backup_db_{YYYY-MM-DD}_{HHmm}.gz in Africa/Tunis (UTC+1)', () => {
      const svc = new TestableDbBackupService(makeDrive(), makeDiscord());
      // 17:00 UTC = 18:00 Africa/Tunis — the scheduled run.
      expect(
        svc.buildBackupFileName(new Date('2026-08-13T17:00:00.000Z')),
      ).toBe('backup_db_2026-08-13_1800.gz');
    });

    it('uses Tunis local time, not UTC, across the day boundary', () => {
      const svc = new TestableDbBackupService(makeDrive(), makeDiscord());
      // 23:30 UTC on the 13th is already 00:30 on the 14th in Tunis.
      expect(
        svc.buildBackupFileName(new Date('2026-08-13T23:30:00.000Z')),
      ).toBe('backup_db_2026-08-14_0030.gz');
    });

    it('does NOT embed the environment in the name (the folder separates envs)', () => {
      const svc = new TestableDbBackupService(makeDrive(), makeDiscord());
      const at = new Date('2026-08-13T17:00:00.000Z');
      process.env.NODE_ENV = 'production';
      const prod = svc.buildBackupFileName(at);
      process.env.NODE_ENV = 'development';
      expect(svc.buildBackupFileName(at)).toBe(prod);
    });
  });

  // ── DB name parsing / no credential leak ────────────────────────────────
  describe('parseDbName', () => {
    it('extracts the database name from a plain URI', () => {
      const svc = new TestableDbBackupService(makeDrive(), makeDiscord());
      expect(svc.parseDbName('mongodb://localhost:27017/fixtronixproddb')).toBe(
        'fixtronixproddb',
      );
    });

    it('extracts the name WITHOUT the credentials or options', () => {
      const svc = new TestableDbBackupService(makeDrive(), makeDiscord());
      const name = svc.parseDbName(
        'mongodb+srv://user:s3cr3t@cluster0.abc.mongodb.net/fixtronixproddb?retryWrites=true',
      );
      expect(name).toBe('fixtronixproddb');
      expect(name).not.toContain('s3cr3t');
      expect(name).not.toContain('user');
    });

    it('returns null when the URI carries no database', () => {
      const svc = new TestableDbBackupService(makeDrive(), makeDiscord());
      expect(svc.parseDbName('mongodb://localhost:27017')).toBeNull();
    });
  });

  // ── Per-environment folder ──────────────────────────────────────────────
  describe('resolveFolderName', () => {
    it.each([
      ['production', 'BACKUPS_PROD'],
      ['preprod', 'BACKUPS_PREPROD'],
      ['development', 'BACKUPS_DEV'],
    ])('%s → %s', (nodeEnv, expected) => {
      process.env.NODE_ENV = nodeEnv;
      const svc = new TestableDbBackupService(makeDrive(), makeDiscord());
      expect(svc.resolveFolderName()).toBe(expected);
    });

    it('gives each environment a DISTINCT folder', () => {
      const svc = new TestableDbBackupService(makeDrive(), makeDiscord());
      const names = ['production', 'preprod', 'development'].map((e) => {
        process.env.NODE_ENV = e;
        return svc.resolveFolderName();
      });
      expect(new Set(names).size).toBe(3);
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────────
  describe('run() — success', () => {
    it('dumps, uploads to the env folder, cleans up, and reports', async () => {
      const drive = makeDrive();
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(drive, discord);
      svc.fakeDumpBytes = 2048;

      const res = await svc.run(new Date('2026-08-13T17:00:00.000Z'));

      expect(res.fileName).toBe('backup_db_2026-08-13_1800.gz');
      expect(res.dbName).toBe('fixtronixproddb');
      expect(res.sizeBytes).toBe(2048);
      expect(res.driveFileId).toBe('drive-file-1');

      // Uploaded into the PRODUCTION folder, under the right name.
      expect(drive.ensureNamedContainer).toHaveBeenCalledWith('BACKUPS_PROD');
      expect(drive.uploadFile).toHaveBeenCalledWith(
        'folder-of-BACKUPS_PROD',
        'backup_db_2026-08-13_1800.gz',
        expect.any(Buffer),
        'application/gzip',
      );

      // Success notification sent, no failure alert.
      expect(discord.sendDbBackupSuccess).toHaveBeenCalledTimes(1);
      expect(discord.sendDbBackupFailure).not.toHaveBeenCalled();

      // Temp file removed.
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('uploads to the PREPROD folder when NODE_ENV=preprod', async () => {
      process.env.NODE_ENV = 'preprod';
      const drive = makeDrive();
      const svc = new TestableDbBackupService(drive, makeDiscord());
      await svc.run(new Date('2026-08-13T17:00:00.000Z'));
      expect(drive.ensureNamedContainer).toHaveBeenCalledWith(
        'BACKUPS_PREPROD',
      );
      expect(drive.uploadFile).toHaveBeenCalledWith(
        'folder-of-BACKUPS_PREPROD',
        expect.any(String),
        expect.any(Buffer),
        'application/gzip',
      );
    });

    it('honours an explicit DB_BACKUP_FOLDER_ID', async () => {
      process.env.DB_BACKUP_FOLDER_ID = 'explicit-folder-id';
      const drive = makeDrive();
      const svc = new TestableDbBackupService(drive, makeDiscord());
      await svc.run();
      expect(drive.ensureNamedContainer).not.toHaveBeenCalled();
      expect(drive.uploadFile).toHaveBeenCalledWith(
        'explicit-folder-id',
        expect.any(String),
        expect.any(Buffer),
        'application/gzip',
      );
    });

    it('never passes the Mongo URI to Drive or Discord', async () => {
      process.env.MONGODB_URI =
        'mongodb://admin:sup3rs3cret@localhost:27017/fixtronixproddb';
      const drive = makeDrive();
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(drive, discord);
      await svc.run();
      const everything = JSON.stringify([
        (drive.uploadFile as jest.Mock).mock.calls.map((c) => [c[0], c[1], c[3]]),
        (discord.sendDbBackupSuccess as jest.Mock).mock.calls,
      ]);
      expect(everything).not.toContain('sup3rs3cret');
      expect(everything).not.toContain('admin');
    });
  });

  // ── Empty dump ──────────────────────────────────────────────────────────
  describe('run() — empty dump', () => {
    it('refuses to upload a 0-byte dump, alerts, and cleans up', async () => {
      const drive = makeDrive();
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(drive, discord);
      svc.fakeDumpBytes = 0;

      await expect(svc.run()).rejects.toThrow(/VIDE/i);

      expect(drive.uploadFile).not.toHaveBeenCalled();
      expect(discord.sendDbBackupFailure).toHaveBeenCalledTimes(1);
      expect(discord.sendDbBackupSuccess).not.toHaveBeenCalled();
      expect(
        (discord.sendDbBackupFailure as jest.Mock).mock.calls[0][0].step,
      ).toBe('dump');
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('fails when mongodump exits 0 but produces no file', async () => {
      const drive = makeDrive();
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(drive, discord);
      svc.fakeDumpBytes = null;

      await expect(svc.run()).rejects.toThrow(/aucun fichier/i);
      expect(drive.uploadFile).not.toHaveBeenCalled();
      expect(discord.sendDbBackupFailure).toHaveBeenCalledTimes(1);
    });
  });

  // ── Failure paths ───────────────────────────────────────────────────────
  describe('run() — failures always alert and always clean up', () => {
    it('alerts when mongodump itself fails, and removes the temp file', async () => {
      const drive = makeDrive();
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(drive, discord);
      svc.dumpError = new Error('Binaire "mongodump" introuvable.');

      await expect(svc.run()).rejects.toThrow(/introuvable/);
      expect(discord.sendDbBackupFailure).toHaveBeenCalledTimes(1);
      expect(drive.uploadFile).not.toHaveBeenCalled();
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('alerts when the Drive upload fails, and STILL removes the temp file', async () => {
      const drive = makeDrive({
        uploadFile: jest.fn(async () => {
          throw new Error('Upload Drive échoué (http=403)');
        }),
      });
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(drive, discord);

      await expect(svc.run()).rejects.toThrow(/Upload Drive échoué/);

      expect(discord.sendDbBackupFailure).toHaveBeenCalledTimes(1);
      expect(
        (discord.sendDbBackupFailure as jest.Mock).mock.calls[0][0].step,
      ).toBe('upload');
      expect(discord.sendDbBackupSuccess).not.toHaveBeenCalled();
      // The point of the `finally`: a failed upload must not leak the archive.
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('rejects an upload that returns no file id (unverifiable success)', async () => {
      const drive = makeDrive({
        uploadFile: jest.fn(async () => ({ id: '', webViewLink: '', name: 'x' })),
      });
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(drive, discord);

      await expect(svc.run()).rejects.toThrow(/aucun identifiant/i);
      expect(discord.sendDbBackupFailure).toHaveBeenCalledTimes(1);
    });

    it('fails fast (no dump) when Drive is not configured', async () => {
      const drive = makeDrive({ isConfigured: jest.fn(async () => false) });
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(drive, discord);

      await expect(svc.run()).rejects.toThrow(/Drive non configuré/i);
      expect(svc.dumpCalls).toHaveLength(0);
      expect(discord.sendDbBackupFailure).toHaveBeenCalledTimes(1);
    });

    it('refuses a URI with no database name', async () => {
      process.env.MONGODB_URI = 'mongodb://localhost:27017';
      const svc = new TestableDbBackupService(makeDrive(), makeDiscord());
      await expect(svc.run()).rejects.toThrow(/nom de base/i);
    });

    it('does not leak credentials into the Discord failure reason', async () => {
      process.env.MONGODB_URI =
        'mongodb://admin:sup3rs3cret@localhost:27017/fixtronixproddb';
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(makeDrive(), discord);
      svc.dumpError = new Error(
        'Failed: mongodb://admin:sup3rs3cret@localhost:27017/fixtronixproddb unreachable',
      );

      await expect(svc.run()).rejects.toThrow();
      const reason = (discord.sendDbBackupFailure as jest.Mock).mock
        .calls[0][0].reason;
      expect(reason).not.toContain('sup3rs3cret');
      expect(reason).toContain('***:***@');
    });
  });

  // ── Retention ───────────────────────────────────────────────────────────
  describe('retention', () => {
    /** N backup files, newest first — the order `listFilesInFolder` returns.
     *  Dates walk backwards one real day at a time from 2026-08-30 so every
     *  generated name is a VALID `backup_db_YYYY-MM-DD_HHmm.gz`. */
    const backups = (n: number) =>
      Array.from({ length: n }, (_, i) => {
        const day = new Date(Date.UTC(2026, 7, 30) - i * 86400000)
          .toISOString()
          .slice(0, 10);
        return {
          id: `id-${i}`,
          name: `backup_db_${day}_1800.gz`,
          createdTime: `${day}T17:00:00Z`,
          size: 1000,
        };
      });

    it('deletes everything past the newest N (default 30)', async () => {
      const drive = makeDrive({
        listFilesInFolder: jest.fn(async () => backups(33)),
      });
      const svc = new TestableDbBackupService(drive, makeDiscord());

      const res = await svc.run();

      expect(res.deleted).toBe(3);
      expect(res.kept).toBe(30);
      expect(drive.deleteFile).toHaveBeenCalledTimes(3);
      // The three OLDEST ids (the tail of the newest-first list).
      expect((drive.deleteFile as jest.Mock).mock.calls.map((c) => c[0])).toEqual(
        ['id-30', 'id-31', 'id-32'],
      );
    });

    it('honours a custom DB_BACKUP_RETENTION', async () => {
      process.env.DB_BACKUP_RETENTION = '5';
      const drive = makeDrive({
        listFilesInFolder: jest.fn(async () => backups(8)),
      });
      const svc = new TestableDbBackupService(drive, makeDiscord());

      const res = await svc.run();

      expect(res.kept).toBe(5);
      expect(res.deleted).toBe(3);
    });

    it('deletes nothing when at or under the limit', async () => {
      const drive = makeDrive({
        listFilesInFolder: jest.fn(async () => backups(30)),
      });
      const svc = new TestableDbBackupService(drive, makeDiscord());

      const res = await svc.run();

      expect(res.deleted).toBe(0);
      expect(drive.deleteFile).not.toHaveBeenCalled();
    });

    it('NEVER purges when the upload failed', async () => {
      const drive = makeDrive({
        listFilesInFolder: jest.fn(async () => backups(50)),
        uploadFile: jest.fn(async () => {
          throw new Error('upload down');
        }),
      });
      const svc = new TestableDbBackupService(drive, makeDiscord());

      await expect(svc.run()).rejects.toThrow('upload down');

      expect(drive.deleteFile).not.toHaveBeenCalled();
      expect(drive.listFilesInFolder).not.toHaveBeenCalled();
    });

    it('NEVER purges when the dump was empty', async () => {
      const drive = makeDrive({
        listFilesInFolder: jest.fn(async () => backups(50)),
      });
      const svc = new TestableDbBackupService(drive, makeDiscord());
      svc.fakeDumpBytes = 0;

      await expect(svc.run()).rejects.toThrow(/VIDE/i);
      expect(drive.deleteFile).not.toHaveBeenCalled();
    });

    it('ignores files that are not backups of ours', async () => {
      process.env.DB_BACKUP_RETENTION = '1';
      const drive = makeDrive({
        listFilesInFolder: jest.fn(async () => [
          ...backups(2),
          {
            id: 'notes',
            name: 'procedure-restauration.pdf',
            createdTime: '2026-01-01T00:00:00Z',
            size: 10,
          },
        ]),
      });
      const svc = new TestableDbBackupService(drive, makeDiscord());

      const res = await svc.run();

      expect(res.deleted).toBe(1);
      expect((drive.deleteFile as jest.Mock).mock.calls.map((c) => c[0])).toEqual(
        ['id-1'],
      );
    });

    it('DB_BACKUP_RETENTION=0 disables the purge', async () => {
      process.env.DB_BACKUP_RETENTION = '0';
      const drive = makeDrive({
        listFilesInFolder: jest.fn(async () => backups(99)),
      });
      const svc = new TestableDbBackupService(drive, makeDiscord());

      const res = await svc.run();

      expect(res.deleted).toBe(0);
      expect(drive.deleteFile).not.toHaveBeenCalled();
    });

    it('a delete failure does not fail the backup', async () => {
      process.env.DB_BACKUP_RETENTION = '1';
      const drive = makeDrive({
        listFilesInFolder: jest.fn(async () => backups(3)),
        deleteFile: jest.fn(async () => {
          throw new Error('403 insufficient permission');
        }),
      });
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(drive, discord);

      const res = await svc.run();

      expect(res.deleted).toBe(0);
      expect(discord.sendDbBackupSuccess).toHaveBeenCalledTimes(1);
    });
  });

  // ── Security gate ───────────────────────────────────────────────────────
  describe('security — folder sharing', () => {
    it('alerts loudly when the backup folder is shared publicly', async () => {
      const drive = makeDrive({
        getFilePermissions: jest.fn(async () => ({
          isPublic: true,
          permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }],
        })),
      });
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(drive, discord);

      await svc.run();

      expect(discord.sendDbBackupFailure).toHaveBeenCalledTimes(1);
      expect(
        (discord.sendDbBackupFailure as jest.Mock).mock.calls[0][0].reason,
      ).toMatch(/PARTAG. PUBLIQUEMENT/);
    });

    it('does not alert for a private folder', async () => {
      const discord = makeDiscord();
      const svc = new TestableDbBackupService(makeDrive(), discord);
      await svc.run();
      expect(discord.sendDbBackupFailure).not.toHaveBeenCalled();
    });
  });
});
