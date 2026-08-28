import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { GoogleDriveService } from 'src/google-drive/google-drive.service';

/** Outcome of one `run()` — returned so the ACTION trigger can one-line-log it
 *  and tests can assert on numbers without inspecting the Discord payload. */
export interface DbBackupResult {
  fileName: string;
  dbName: string;
  sizeBytes: number;
  durationMs: number;
  folderId: string;
  folderName: string;
  driveFileId: string;
  webViewLink: string;
  /** Retention: how many old backups were purged AFTER the upload succeeded. */
  deleted: number;
  /** Retention: how many backups remain in the folder (this one included). */
  kept: number;
}

/** Steps, used to tag the Discord failure embed so the operator knows where
 *  it broke without opening the logs. */
type BackupStep = 'config' | 'dump' | 'folder' | 'upload' | 'retention';

/** Raised with the step attached, so `run()`'s catch can report precisely. */
class DbBackupError extends Error {
  constructor(
    message: string,
    readonly step: BackupStep,
  ) {
    super(message);
    this.name = 'DbBackupError';
  }
}

/**
 * BACKUP_DB_TO_DRIVE — nightly MongoDB backup pushed to Google Drive.
 *
 * Pipeline (each step fails LOUDLY — never a fake success):
 *   1. `mongodump --uri=<MONGODB_URI> --gzip --archive=<tmp>` — the URI comes
 *      from the ACTIVE environment's `.env.${NODE_ENV}`, so each environment
 *      dumps ITS OWN database with no extra configuration.
 *   2. Sanity-check the archive is NON-EMPTY (a 0-byte dump uploaded "with
 *      success" is the single worst outcome this service can produce).
 *   3. Upload to a per-environment Drive folder via the EXISTING
 *      `GoogleDriveService` (same OAuth grant as the DI documents).
 *   4. Retention: keep the newest N, delete the rest — ONLY once the upload
 *      returned a real Drive file id.
 *   5. Discord: a short line on success, a loud alert on failure. Both use the
 *      UNGATED `deliverEmbed` path (see `DiscordHookService`).
 * The temporary archive is removed in a `finally`, upload succeeded or not —
 * otherwise the disk fills up silently, one dump per night.
 *
 * ⚠️ SECURITY — the archive contains EVERY collection, including the `profile`
 * password hashes. Two rules follow, both enforced here:
 *   - the full Mongo URI is NEVER logged (it can carry credentials); only the
 *     database name is. See `parseDbName`.
 *   - the destination folder's sharing is checked before/at upload and a public
 *     ("anyone with the link") folder raises a loud warning + Discord alert.
 *
 * Env vars (all optional except `MONGODB_URI`, which the app already requires):
 *   MONGODUMP_PATH        absolute path to the binary (default `mongodump`,
 *                         i.e. resolved from PATH)
 *   DB_BACKUP_FOLDER_ID   explicit Drive folder id — wins over the name
 *   DB_BACKUP_FOLDER_NAME folder name (default `BACKUPS_{PROD|PREPROD|DEV}`),
 *                         created under the env's GOOGLE_DRIVE_PARENT_FOLDER_ID
 *   DB_BACKUP_RETENTION   how many backups to keep (default 30, 0 = unlimited)
 *   DB_BACKUP_TMP_DIR     where the archive is written (default os.tmpdir())
 *   MONGODUMP_TIMEOUT_MS  hard kill for a hung dump (default 600000 = 10 min)
 */
@Injectable()
export class DbBackupService {
  private readonly logger = new Logger(DbBackupService.name);

  /** Default number of backups kept in the Drive folder. */
  static readonly DEFAULT_RETENTION = 30;
  /** A dump hung on a lock must not wedge the cron forever. */
  static readonly DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

  constructor(
    private readonly drive: GoogleDriveService,
    private readonly discord: DiscordHookService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // Pure helpers (unit-testable without mongodump or Drive)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Extract ONLY the database name from a Mongo connection string. Used for
   * every log line and every Discord field, so the credentials that may sit in
   * the URI (`mongodb://user:pass@host/db`) never reach a log file, an embed,
   * or a terminal. Returns `null` when the URI carries no database path —
   * which is a hard configuration error for a backup (`mongodump` would then
   * dump the WHOLE cluster, not this environment's database).
   */
  parseDbName(uri: string): string | null {
    if (!uri) return null;
    // Strip the scheme, then everything up to the authority's `/`. Query string
    // and options are dropped. Deliberately string-based: `new URL()` rejects
    // several legal `mongodb+srv://` forms.
    const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//i, '');
    const slash = withoutScheme.indexOf('/');
    if (slash === -1) return null;
    const afterSlash = withoutScheme.slice(slash + 1);
    const dbName = afterSlash.split(/[?#]/)[0].trim();
    return dbName ? decodeURIComponent(dbName) : null;
  }

  /**
   * `backup_db_{YYYY-MM-DD}_{HHmm}.gz`, stamped in `APP_TIMEZONE`
   * (default `Africa/Tunis`) — e.g. `backup_db_2026-08-13_1800.gz`.
   *
   * ⚠️ The environment is deliberately NOT part of the name: the FOLDER
   * separates environments (see `resolveFolderName`). Identical names across
   * folders are intentional and make a restore unambiguous — you pick the
   * folder, not a suffix.
   */
  buildBackupFileName(at: Date = new Date()): string {
    const tz = process.env.APP_TIMEZONE || 'Africa/Tunis';
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at)) {
      parts[p.type] = p.value;
    }
    // Some ICU builds emit hour "24" at midnight — normalize to "00".
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `backup_db_${parts.year}-${parts.month}-${parts.day}_${hour}${parts.minute}.gz`;
  }

  /** True for names this service owns — the retention purge only ever
   *  considers these, so an unrelated file dropped in the folder is safe. */
  isBackupFileName(name: string): boolean {
    return /^backup_db_\d{4}-\d{2}-\d{2}_\d{4}\.gz$/.test(name || '');
  }

  /**
   * Per-environment Drive folder name. `DB_BACKUP_FOLDER_NAME` overrides;
   * otherwise derived from `NODE_ENV` so the three environments can NEVER
   * collide even if they were ever pointed at the same Drive parent:
   *   production → BACKUPS_PROD · preprod → BACKUPS_PREPROD · * → BACKUPS_DEV
   */
  resolveFolderName(): string {
    const override = process.env.DB_BACKUP_FOLDER_NAME?.trim();
    if (override) return override;
    switch ((process.env.NODE_ENV || 'development').trim()) {
      case 'production':
        return 'BACKUPS_PROD';
      case 'preprod':
        return 'BACKUPS_PREPROD';
      default:
        return 'BACKUPS_DEV';
    }
  }

  /** Retention size: `DB_BACKUP_RETENTION`, default 30. `0` disables the
   *  purge entirely (explicit opt-out, logged). Invalid → default. */
  resolveRetention(): number {
    const raw = process.env.DB_BACKUP_RETENTION?.trim();
    if (raw === undefined || raw === '') return DbBackupService.DEFAULT_RETENTION;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      this.logger.warn(
        `DB_BACKUP_RETENTION invalide ("${raw}") → valeur par défaut ${DbBackupService.DEFAULT_RETENTION}.`,
      );
      return DbBackupService.DEFAULT_RETENTION;
    }
    return n;
  }

  // ───────────────────────────────────────────────────────────────────────
  // mongodump
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Run `mongodump` into `archivePath`. Isolated + protected so the unit tests
   * can stub it and exercise the whole pipeline without a real Mongo/binary.
   *
   * ⚠️ `--uri` puts the connection string on the process argv, where a local
   * `ps` can read it. Acceptable here (the deployment connects to a local
   * mongod without credentials); if authentication is ever added to the URI,
   * switch to `mongodump --config=<file>` with the password in a 0600 file.
   */
  protected runMongodump(uri: string, archivePath: string): Promise<void> {
    const bin = process.env.MONGODUMP_PATH?.trim() || 'mongodump';
    const timeoutMs =
      Number(process.env.MONGODUMP_TIMEOUT_MS) ||
      DbBackupService.DEFAULT_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        bin,
        [`--uri=${uri}`, '--gzip', `--archive=${archivePath}`],
        { windowsHide: true },
      );

      // mongodump writes its progress to stderr; keep only the tail for the
      // error message. NEVER echo it wholesale — the URI is echoed back by
      // some builds, and it can carry credentials.
      let stderrTail = '';
      child.stderr?.on('data', (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-2000);
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        // ENOENT = the binary is not installed / not on PATH. This is the
        // single most likely production failure, so give the exact remedy.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              `Binaire "${bin}" introuvable. mongodump fait partie de ` +
                '"mongodb-database-tools" (paquet SYSTÈME, PAS npm) : ' +
                'installe-le sur le serveur (apk add mongodb-tools / apt install mongodb-database-tools) ' +
                'ou renseigne MONGODUMP_PATH avec le chemin absolu du binaire.',
            ),
          );
          return;
        }
        reject(new Error(`Échec du lancement de mongodump : ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new Error(
              `mongodump interrompu après ${timeoutMs} ms (timeout MONGODUMP_TIMEOUT_MS).`,
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `mongodump a terminé avec le code ${code}. ${this.redact(stderrTail).slice(-500)}`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  }

  /** Last-resort scrubber: masks any `mongodb://user:pass@` pair that a child
   *  process echoed back into its own output before we log it. */
  private redact(text: string): string {
    return (text || '').replace(
      /(mongodb(?:\+srv)?:\/\/)[^\s@]*@/gi,
      '$1***:***@',
    );
  }

  // ───────────────────────────────────────────────────────────────────────
  // Orchestration
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Full backup run. Throws on any failure (after alerting Discord) so the
   * ACTION bootstrap logs "ACTION failed" and sets `process.exitCode = 1` —
   * a monitorable signal for the crontab, never a silent no-op.
   */
  async run(now: Date = new Date()): Promise<DbBackupResult> {
    const startedAt = Date.now();
    const env = (process.env.NODE_ENV || 'development').trim();
    const uri = process.env.MONGODB_URI?.trim() || '';
    const dbName = this.parseDbName(uri);
    // Temp file path is decided up front so the `finally` can always clean it.
    const fileName = this.buildBackupFileName(now);
    const tmpDir = process.env.DB_BACKUP_TMP_DIR?.trim() || os.tmpdir();
    const archivePath = path.join(tmpDir, `fixtronix-${process.pid}-${fileName}`);
    let step: BackupStep = 'config';

    try {
      if (!uri) {
        throw new DbBackupError(
          'MONGODB_URI absent — impossible de savoir quelle base sauvegarder.',
          'config',
        );
      }
      if (!dbName) {
        throw new DbBackupError(
          "MONGODB_URI ne contient pas de nom de base (ex. mongodb://host:27017/fixtronixproddb). " +
            'Refus de lancer un dump sur le cluster entier.',
          'config',
        );
      }
      if (!(await this.drive.isConfigured())) {
        throw new DbBackupError(
          'Google Drive non configuré (OAuth absent) — la sauvegarde ne pourrait pas être envoyée.',
          'config',
        );
      }

      // ── 1. Dump ────────────────────────────────────────────────────────
      step = 'dump';
      this.logger.log(
        `Sauvegarde [${env}] : dump de la base "${dbName}" → ${fileName}`,
      );
      fs.mkdirSync(tmpDir, { recursive: true });
      await this.runMongodump(uri, archivePath);

      // ── 2. Verify the archive is real ──────────────────────────────────
      if (!fs.existsSync(archivePath)) {
        throw new DbBackupError(
          `mongodump s'est terminé sans erreur mais aucun fichier n'a été produit (${fileName}).`,
          'dump',
        );
      }
      const sizeBytes = fs.statSync(archivePath).size;
      if (sizeBytes <= 0) {
        throw new DbBackupError(
          `Dump VIDE (0 octet) pour la base "${dbName}" — upload refusé. ` +
            'Un backup vide uploadé « avec succès » est le pire scénario possible.',
          'dump',
        );
      }
      this.logger.log(`Dump OK : ${sizeBytes} octets`);

      // ── 3. Resolve the per-environment folder ──────────────────────────
      step = 'folder';
      const folderName = this.resolveFolderName();
      const explicitId = process.env.DB_BACKUP_FOLDER_ID?.trim();
      const folderId = explicitId
        ? explicitId
        : await this.drive.ensureNamedContainer(folderName);
      this.logger.log(
        `Dossier Drive de sauvegarde [${env}] : "${folderName}" (${folderId})`,
      );
      await this.assertFolderNotPublic(folderId, folderName, env);

      // ── 4. Upload ──────────────────────────────────────────────────────
      step = 'upload';
      const buffer = fs.readFileSync(archivePath);
      const uploaded = await this.drive.uploadFile(
        folderId,
        fileName,
        buffer,
        'application/gzip',
      );
      if (!uploaded?.id) {
        throw new DbBackupError(
          "L'upload Drive n'a retourné aucun identifiant de fichier — succès non vérifiable.",
          'upload',
        );
      }
      this.logger.log(`Upload Drive OK : ${fileName} (${uploaded.id})`);

      // ── 5. Retention — ONLY now that the upload is confirmed ───────────
      step = 'retention';
      const { deleted, kept } = await this.purgeOldBackups(folderId);

      const durationMs = Date.now() - startedAt;
      const result: DbBackupResult = {
        fileName,
        dbName,
        sizeBytes,
        durationMs,
        folderId,
        folderName,
        driveFileId: uploaded.id,
        webViewLink: uploaded.webViewLink ?? '',
        deleted,
        kept,
      };

      // Success line — its ABSENCE is the daily alarm, so it is sent last and
      // best-effort (a Discord outage must not turn a good backup into a
      // failure: the dump IS on Drive at this point).
      try {
        await this.discord.sendDbBackupSuccess({
          fileName,
          dbName,
          sizeBytes,
          durationMs,
          folderName,
          webViewLink: result.webViewLink,
          deleted,
          kept,
          env,
        });
      } catch (err) {
        this.logger.warn(
          `Notification Discord de succès non envoyée : ${(err as Error).message}`,
        );
      }

      this.logger.log(
        `Sauvegarde terminée [${env}] · base=${dbName} fichier=${fileName} ` +
          `taille=${sizeBytes}o durée=${durationMs}ms rétention: ${kept} conservé(s), ${deleted} supprimé(s)`,
      );
      return result;
    } catch (err) {
      const reason = this.redact((err as Error)?.message ?? String(err));
      const failedStep = err instanceof DbBackupError ? err.step : step;
      this.logger.error(
        `ÉCHEC sauvegarde [${env}] à l'étape "${failedStep}" : ${reason}`,
      );
      // Alert first, best-effort — a failing webhook must not mask the real
      // cause, which is rethrown below.
      try {
        await this.discord.sendDbBackupFailure({
          reason,
          dbName: dbName ?? undefined,
          step: failedStep,
          env,
        });
      } catch (notifyErr) {
        this.logger.error(
          `Alerte Discord d'échec NON envoyée : ${(notifyErr as Error).message}`,
        );
      }
      throw err instanceof Error ? err : new Error(reason);
    } finally {
      // ALWAYS remove the temp archive — success, dump failure, upload failure
      // or crash. Skipping this fills the disk one dump per night, silently.
      try {
        if (fs.existsSync(archivePath)) {
          fs.unlinkSync(archivePath);
          this.logger.log(`Fichier temporaire supprimé : ${archivePath}`);
        }
      } catch (cleanupErr) {
        this.logger.error(
          `Fichier temporaire NON supprimé (${archivePath}) : ${(cleanupErr as Error).message}`,
        );
      }
    }
  }

  /**
   * Retention — keep the newest N `backup_db_*.gz`, permanently delete the
   * rest. Called ONLY after a confirmed upload, so a failed run can never
   * shrink the history.
   *
   * A delete failure is logged and counted but does NOT fail the run: the
   * backup itself is already safe on Drive, and turning a successful backup
   * into a failure because a purge hiccuped would be the wrong trade.
   */
  private async purgeOldBackups(
    folderId: string,
  ): Promise<{ deleted: number; kept: number }> {
    const retention = this.resolveRetention();
    const files = (await this.drive.listFilesInFolder(folderId)).filter((f) =>
      this.isBackupFileName(f.name),
    );
    if (retention === 0) {
      this.logger.warn(
        `Rétention désactivée (DB_BACKUP_RETENTION=0) — ${files.length} sauvegarde(s) conservée(s), le dossier Drive grossira indéfiniment.`,
      );
      return { deleted: 0, kept: files.length };
    }
    if (files.length <= retention) {
      return { deleted: 0, kept: files.length };
    }

    // `listFilesInFolder` returns newest-first; everything past N is obsolete.
    const obsolete = files.slice(retention);
    let deleted = 0;
    for (const f of obsolete) {
      try {
        await this.drive.deleteFile(f.id);
        deleted++;
        this.logger.log(`Rétention : ancienne sauvegarde supprimée ${f.name}`);
      } catch (err) {
        this.logger.warn(
          `Rétention : suppression de ${f.name} échouée — ${(err as Error).message}`,
        );
      }
    }
    return { deleted, kept: files.length - deleted };
  }

  /**
   * ⚠️ SECURITY GATE — the dump holds every collection, password hashes
   * included. A backup folder shared with "anyone with the link" would publish
   * the entire database. We warn loudly + alert Discord rather than throw: the
   * backup itself is still worth taking, but this must never pass unnoticed.
   * A permissions read failure is non-fatal (the `drive.file` scope may not
   * grant `permissions.list` on every folder).
   */
  private async assertFolderNotPublic(
    folderId: string,
    folderName: string,
    env: string,
  ): Promise<void> {
    try {
      const { isPublic, permissions } = await this.drive.getFilePermissions(
        folderId,
      );
      if (isPublic) {
        const msg =
          `Le dossier de sauvegarde "${folderName}" (${folderId}) est PARTAGÉ PUBLIQUEMENT ` +
          "(permission « anyone »). Le dump contient TOUTE la base, hachages de mots de passe inclus. " +
          'Retire ce partage immédiatement dans Google Drive.';
        this.logger.error(`🚨 ${msg}`);
        await this.discord
          .sendDbBackupFailure({
            reason: msg,
            step: 'folder',
            env,
          })
          .catch(() => undefined);
      } else {
        this.logger.log(
          `Permissions du dossier "${folderName}" : ${permissions.length} entrée(s), aucun partage public ✅`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Permissions du dossier de sauvegarde non vérifiables (${(err as Error).message}) — à contrôler manuellement dans Drive.`,
      );
    }
  }
}
