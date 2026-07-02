import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { google, drive_v3 } from 'googleapis';
import { GoogleOAuthService } from '../google-auth/google-auth.service';

export interface DriveFolder {
  id: string;
  webViewLink: string;
}

export interface DriveFile {
  id: string;
  webViewLink: string;
  name: string;
}

/** Entity kinds that get their own structured folder under the CLIENTS root
 *  (company/client are DI targets; composant groups its datasheets). */
export type DriveEntityType = 'company' | 'client' | 'composant';

/** Document categories — same naming scheme for every upload, images included. */
export type DriveDocType =
  | 'BC'
  | 'Devis'
  | 'BL'
  | 'Facture'
  | 'FicheTechnique'
  | 'Image';

/**
 * Google Drive v3 client — authenticated via **OAuth 2.0** as a REAL Google
 * account (the one that owns the storage quota), NOT a service account.
 *
 * Why OAuth and not the service account: a service account has **no storage
 * quota**, so uploading a file fails with `storageQuotaExceeded` unless the
 * parent lives in a Shared Drive (a Workspace-only feature). The project's
 * Drive lives in a personal account, so we authenticate AS that account: files
 * are then owned by it and billed to its quota.
 *
 * Flow (one-time dev setup): `GET /auth/google` → consent (scope `drive.file`,
 * `access_type=offline`, `prompt=consent`) with the quota-owning account →
 * `GET /oauth/callback` returns a **refresh token** → paste it into
 * `GOOGLE_OAUTH_REFRESH_TOKEN`. At runtime the OAuth2 client refreshes the
 * access token automatically from that refresh token.
 *
 * Folder layout (unchanged — stable, idempotent, all files of an entity in the
 * SAME folder):
 *   {GOOGLE_DRIVE_PARENT_FOLDER_ID}        ← the "CLIENTS" parent
 *     ├── company/{Name}_{date}_{heure}/
 *     └── client/{Name}_{date}_{heure}/
 *
 * `supportsAllDrives: true` is kept on every call so a Shared-Drive parent also
 * works if the account is later moved to Workspace.
 * See `.project-context/decisions/04-google-drive-client-folders.md`.
 */
@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);
  private drive: drive_v3.Drive | null = null;
  /** Cache of resolved container folder ids (`company`, `client`) keyed by type. */
  private readonly containerCache = new Map<string, string>();

  /** OAuth is centralized in `GoogleOAuthService` (shared with Google Sheets):
   *  one Gmail grant, one refresh token, combined Drive + Sheets scopes. */
  constructor(private readonly oauth: GoogleOAuthService) {}

  /** True when Drive is configured (OAuth client + refresh token present). The
   *  parent folder is OPTIONAL — when empty, the app creates its own `CLIENTS`
   *  folder. Delegated to the shared OAuth factory. */
  isConfigured(): boolean {
    return this.oauth.isConfigured();
  }

  /** Consent URL for the one-time setup (`GET /auth/google` redirects here).
   *  Delegated to the shared factory, which requests the Drive + Sheets scopes. */
  generateAuthUrl(): string {
    return this.oauth.generateAuthUrl();
  }

  /** Exchange the `code` from the OAuth callback for tokens (incl. the refresh
   *  token to paste into `.env`). Delegated to the shared factory. */
  async exchangeCodeForTokens(code: string) {
    return this.oauth.exchangeCodeForTokens(code);
  }

  private async ensureClient(): Promise<drive_v3.Drive> {
    if (this.drive) return this.drive;
    // Shared OAuth2 client (refresh token set) — same grant as Google Sheets.
    const auth = this.oauth.getAuthenticatedClient();
    this.drive = google.drive({ version: 'v3', auth });
    return this.drive;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Name sanitization
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Folder-name sanitizer: keep the name readable & STABLE (spaces + accents
   * preserved) but strip control chars and the characters illegal on
   * desktop-sync filesystems (`/ \ : * ? " < > |`). Collapses whitespace.
   */
  sanitizeFolderName(name: string): string {
    const cleaned = (name || '')
      .replace(/[\/\\:*?"<>|]/g, '')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || 'Entity';
  }

  /**
   * File-name part sanitizer for `{Name}`: strip diacritics, drop spaces and
   * illegal chars — Drive- and desktop-safe, without distorting the name.
   * e.g. `Excubia Skandér` → `ExcubiaSkander`.
   */
  sanitizeFileNamePart(name: string): string {
    // NFD decomposes accents into base char + combining mark; drop the marks
    // (U+0300–U+036F) by codepoint so the source stays plain-ASCII.
    const noAccents = (name || '')
      .normalize('NFD')
      .split('')
      .filter((ch) => {
        const code = ch.charCodeAt(0);
        return code < 0x0300 || code > 0x036f;
      })
      .join('');
    const cleaned = noAccents
      .replace(/[\/\\:*?"<>|]/g, '')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, '')
      .trim();
    return cleaned || 'Doc';
  }

  /**
   * Build the standardized upload file name:
   *   `{Name}_{DocType}_{DD-MM-YYYY}_{HH-mm-ss}.{ext}`
   * Timezone `APP_TIMEZONE` (default `Africa/Tunis`), 24h, `-` separators.
   * The real extension is preserved (lower-cased, alnum only).
   *   → `ExcubiaSkander_BL_18-06-2026_11-30-45.pdf`
   */
  buildDocFileName(
    name: string,
    docType: DriveDocType,
    ext: string,
    createdAt: Date = new Date(),
  ): string {
    const tz = process.env.APP_TIMEZONE || 'Africa/Tunis';
    const stamp = this.formatTimestamp(createdAt, tz, 'DD-MM-YYYY_HH-mm-ss');
    const cleanName = this.sanitizeFileNamePart(name);
    const cleanExt = (ext || 'bin').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return `${cleanName}_${docType}_${stamp}.${cleanExt || 'bin'}`;
  }

  /**
   * Build the entity folder name with the entity's creation timestamp, FROZEN
   * forever (the folder is created once and reused by `driveFolderId`):
   *   `{Name}_{DD-MM-YYYY}_{HH-mm-ss}`  (Africa/Tunis, 24h, underscores)
   *   → `ExcubiaSkander_18-06-2026_11-30-45`
   * The name part is sanitized the same way as file names (accents/spaces/illegal
   * chars dropped) so it stays Drive- and desktop-safe.
   */
  buildEntityFolderName(name: string, createdAt: Date = new Date()): string {
    const tz = process.env.APP_TIMEZONE || 'Africa/Tunis';
    const stamp = this.formatTimestamp(createdAt, tz, 'DD-MM-YYYY_HH-mm-ss');
    return `${this.sanitizeFileNamePart(name)}_${stamp}`;
  }

  private formatTimestamp(date: Date, tz: string, fmt: string): string {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date)) {
      parts[p.type] = p.value;
    }
    const hour = parts.hour === '24' ? '00' : parts.hour; // some envs emit 24 at midnight
    return fmt
      .replace(/YYYY/g, parts.year)
      .replace(/MM/g, parts.month)
      .replace(/DD/g, parts.day)
      .replace(/HH/g, hour)
      .replace(/mm/g, parts.minute)
      .replace(/ss/g, parts.second);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Folder management (idempotent find-or-create)
  // ───────────────────────────────────────────────────────────────────────

  /** Find a non-trashed sub-folder by exact name under `parentId`, or null. */
  private async findFolder(
    drive: drive_v3.Drive,
    name: string,
    parentId: string,
  ): Promise<DriveFolder | null> {
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = [
      `name = '${escaped}'`,
      `'${parentId}' in parents`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      'trashed = false',
    ].join(' and ');
    const res = await drive.files.list({
      q,
      fields: 'files(id, webViewLink)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 1,
    });
    const f = res.data.files?.[0];
    return f?.id ? { id: f.id, webViewLink: f.webViewLink ?? '' } : null;
  }

  /**
   * Find non-trashed sub-folders under `parentId` whose name starts with
   * `{namePrefix}_` (the canonical `{Name}_{timestamp}` separator). Returned
   * sorted by `createdTime` ASC so the OLDEST folder always comes first.
   *
   * Drive's query language has no native "starts with" on `name`; we use
   * `name contains '{prefix}_'` to narrow the server-side scan, then enforce
   * the actual prefix client-side. The trailing underscore stops `Acme` from
   * bleeding into `AcmeBis_*`. Limited to one page (pageSize 100) — a single
   * entity having more than 100 duplicate folders is its own incident.
   *
   * Used by `ensureEntityFolder` to REUSE a previously-created entity folder
   * when the entity's stored `driveFolderId` is gone (cleared by a migration,
   * stale 404, or just never persisted). Restricted to folders the OAuth app
   * created (the `drive.file` scope) — folders made by hand in the UI are
   * intentionally not matched.
   */
  private async findFoldersByNamePrefix(
    drive: drive_v3.Drive,
    namePrefix: string,
    parentId: string,
  ): Promise<DriveFolder[]> {
    const probe = `${namePrefix}_`;
    const escaped = probe.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = [
      `name contains '${escaped}'`,
      `'${parentId}' in parents`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      'trashed = false',
    ].join(' and ');
    const res = await drive.files.list({
      q,
      fields: 'files(id, name, createdTime, webViewLink)',
      orderBy: 'createdTime',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 100,
    });
    const files = res.data.files ?? [];
    const matches = files
      .filter((f) => typeof f.name === 'string' && f.name.startsWith(probe))
      .map((f) => ({
        id: f.id as string,
        webViewLink: f.webViewLink ?? '',
        createdTime: f.createdTime ?? '',
      }))
      .filter((f) => !!f.id);
    // `orderBy` already sorts ASC, but defensively re-sort: createdTime can
    // be missing in some edge cases and we want a deterministic "first" pick.
    matches.sort((a, b) =>
      (a.createdTime || '').localeCompare(b.createdTime || ''),
    );
    return matches.map(({ id, webViewLink }) => ({ id, webViewLink }));
  }

  /** Create a sub-folder by name under `parentId` (no find — always creates). */
  private async createSubFolder(
    drive: drive_v3.Drive,
    name: string,
    parentId: string,
  ): Promise<DriveFolder> {
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });
    if (!res.data.id) throw new Error('Drive folder create returned no id');
    return { id: res.data.id, webViewLink: res.data.webViewLink ?? '' };
  }

  /** Find-or-create a sub-folder by name under `parentId` (idempotent). Used for
   *  the STABLE container folders (company / client / composants) only. */
  private async ensureFolder(
    drive: drive_v3.Drive,
    name: string,
    parentId: string,
  ): Promise<DriveFolder> {
    const existing = await this.findFolder(drive, name, parentId);
    if (existing) return existing;
    return this.createSubFolder(drive, name, parentId);
  }

  /**
   * Find-or-create the root parent folder, CREATED BY THIS OAUTH APP at
   * the Drive root — so it is visible under the `drive.file` scope
   * (which only sees what the app created). All company/client subtrees
   * then live under it.
   *
   * The name is env-driven so each environment can have its own root
   * (`FIXTRONIX-ERP-DEV` in dev, `CLIENTS` in prod, etc.) without a
   * code change. Fallback: `CLIENTS` (legacy default). Cached; the id
   * is logged so it can optionally be frozen in
   * `GOOGLE_DRIVE_PARENT_FOLDER_ID`.
   */
  private async ensureRootClientsFolder(
    drive: drive_v3.Drive,
  ): Promise<string> {
    const rootName =
      process.env.GOOGLE_DRIVE_ROOT_FOLDER_NAME?.trim() || 'CLIENTS';
    const cacheKey = `__root:${rootName}`;
    const cached = this.containerCache.get(cacheKey);
    if (cached) return cached;
    const folder = await this.ensureFolder(drive, rootName, 'root');
    this.containerCache.set(cacheKey, folder.id);
    this.logger.log(
      `Root folder "${rootName}" ready (id=${folder.id}). ` +
        `Set GOOGLE_DRIVE_PARENT_FOLDER_ID=${folder.id} to freeze it.`,
    );
    return folder.id;
  }

  /**
   * Resolve the parent folder for the CLIENTS subtree:
   *   - `GOOGLE_DRIVE_PARENT_FOLDER_ID` set → use it (the app must be able to
   *     see it — i.e. it created it, or the broader `drive` scope is used).
   *   - empty → the app find-or-creates its own `CLIENTS` at the root, which is
   *     always visible under `drive.file`.
   */
  private async resolveParentId(drive: drive_v3.Drive): Promise<string> {
    const configured = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID?.trim();
    if (configured) return configured;
    return this.ensureRootClientsFolder(drive);
  }

  /** Resolve (create if missing) the `company`/`client` container under the
   *  CLIENTS parent. Cached for the process lifetime. */
  private async ensureTypeContainer(
    drive: drive_v3.Drive,
    type: DriveEntityType,
  ): Promise<string> {
    const cached = this.containerCache.get(type);
    if (cached) return cached;
    const parent = await this.resolveParentId(drive);
    const container = await this.ensureFolder(drive, type, parent);
    this.containerCache.set(type, container.id);
    return container.id;
  }

  /**
   * Find-or-create the entity folder under `{type}/`. Resolution order:
   *   1. Look up folders whose name starts with `{SanitizedName}_` (the
   *      `{Name}_{timestamp}` separator) in the type container. If ≥ 1
   *      match, REUSE the oldest one — even if `createdAt` here doesn't
   *      reproduce the original folder's exact timestamp.
   *   2. None found → create a new `{Name}_{DD-MM-YYYY}_{HH-mm-ss}` folder.
   *
   * Why prefix and not exact name? The original implementation matched on the
   * exact timestamped name, which only worked while the caller passed the
   * entity's FROZEN `createdAt`. A legacy code path passing `new Date()`, or
   * any drift in the timestamp source, broke the lookup and produced
   * duplicates. Matching by `{Name}_` prefix is robust to any timestamp.
   *
   * Multiple matches (= pre-existing duplicates) → pick the oldest, log the
   * extras at warn. We never CREATE if any match exists.
   *
   * Scope: limited to folders the OAuth app created (the `drive.file` scope)
   * — folders made by hand in the Drive UI are intentionally not visible.
   *
   * Used by BOTH company and client.
   */
  async ensureEntityFolder(
    type: DriveEntityType,
    name: string,
    createdAt: Date = new Date(),
  ): Promise<DriveFolder> {
    const drive = await this.ensureClient();
    const containerId = await this.ensureTypeContainer(drive, type);
    const sanitizedName = this.sanitizeFileNamePart(name);

    const matches = await this.findFoldersByNamePrefix(
      drive,
      sanitizedName,
      containerId,
    );
    if (matches.length > 0) {
      const oldest = matches[0];
      if (matches.length > 1) {
        const extras = matches
          .slice(1)
          .map((m) => m.id)
          .join(', ');
        this.logger.warn(
          `Entity has ${matches.length} folders matching ${type}/${sanitizedName}_*. ` +
            `Reusing oldest (${oldest.id}); duplicate ids: ${extras}.`,
        );
      } else {
        this.logger.log(
          `Entity Drive folder REUSED by prefix: ${type}/${sanitizedName}_* (${oldest.id})`,
        );
      }
      return oldest;
    }

    const folderName = this.buildEntityFolderName(name, createdAt);
    const folder = await this.createSubFolder(drive, folderName, containerId);
    this.logger.log(
      `Entity Drive folder created: ${type}/${folderName} (${folder.id})`,
    );
    return folder;
  }

  /**
   * Ensure (create if missing) a top-level container folder by name directly
   * under the configured parent — e.g. `composants` for catalog datasheets that
   * aren't tied to a company/client. Cached. Idempotent.
   */
  async ensureNamedContainer(name: string): Promise<string> {
    const cacheKey = `__container:${name}`;
    const cached = this.containerCache.get(cacheKey);
    if (cached) return cached;
    const drive = await this.ensureClient();
    const parent = await this.resolveParentId(drive);
    const folder = await this.ensureFolder(drive, name, parent);
    this.containerCache.set(cacheKey, folder.id);
    return folder.id;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Upload
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Upload a file (buffer) into `folderId` under `fileName`. Returns the Drive
   * file id + webViewLink. Throws on misconfiguration / API error — callers
   * treat Drive as best-effort and must surface a clear error, never a fake
   * success.
   */
  async uploadFile(
    folderId: string,
    fileName: string,
    buffer: Buffer,
    mimeType?: string,
  ): Promise<DriveFile> {
    const drive = await this.ensureClient();
    let res;
    try {
      res = await drive.files.create({
        requestBody: { name: fileName, parents: [folderId] },
        media: {
          mimeType: mimeType || 'application/octet-stream',
          body: Readable.from(buffer),
        },
        fields: 'id, webViewLink, name',
        supportsAllDrives: true,
      });
    } catch (err) {
      // A service account has NO storage quota, so it can CREATE folders (0
      // bytes) but cannot STORE a file unless the parent lives in a Shared
      // Drive (storage billed to the Workspace org). If the parent is in a
      // personal My Drive, the upload is billed to the SA → this error. Turn
      // Google's cryptic message into an actionable one.
      if (this.isQuotaError(err)) {
        throw new Error(
          'Upload Drive refusé : le compte de service n’a pas de quota de stockage. ' +
            'Le dossier parent (GOOGLE_DRIVE_PARENT_FOLDER_ID) doit être DANS un Shared Drive ' +
            'dont le service account est membre (Content Manager) — pas un My Drive personnel. ' +
            `Détail Google : ${(err as Error)?.message ?? String(err)}`,
        );
      }
      throw err;
    }
    const id = res.data.id;
    if (!id) throw new Error('Drive file create returned no id');
    this.logger.log(`Uploaded "${fileName}" to folder ${folderId} (${id})`);
    return {
      id,
      webViewLink: res.data.webViewLink ?? '',
      name: res.data.name ?? fileName,
    };
  }

  /** Recognize the service-account "no storage quota" failure (any of the shapes
   *  googleapis surfaces it as). */
  private isQuotaError(err: unknown): boolean {
    const reason = (err as any)?.errors?.[0]?.reason ?? (err as any)?.reason;
    const message =
      (err as any)?.errors?.[0]?.message ??
      (err as any)?.response?.data?.error?.message ??
      (err as any)?.message ??
      '';
    return (
      reason === 'storageQuotaExceeded' ||
      /storage quota|do not have storage/i.test(String(message))
    );
  }

  /**
   * Recognize a Drive "file/folder not found" (404). Used to auto-repair a
   * stale stored `driveFolderId` (e.g. a folder created by the old service
   * account, invisible to the OAuth account, or deleted).
   */
  isNotFoundError(err: unknown): boolean {
    const code = (err as any)?.code ?? (err as any)?.response?.status;
    const reason = (err as any)?.errors?.[0]?.reason ?? (err as any)?.reason;
    const message =
      (err as any)?.errors?.[0]?.message ??
      (err as any)?.response?.data?.error?.message ??
      (err as any)?.message ??
      '';
    // Anchored "^File not found" matches Drive's canonical 404 ("File not found:
    // {id}") without catching arbitrary errors that merely mention "not found"
    // somewhere in the message — the previous broad regex turned every
    // unrelated upload failure into a forceRecreate, which is one of the paths
    // that produced duplicate entity folders.
    return (
      code === 404 ||
      reason === 'notFound' ||
      /^file not found\b/i.test(String(message).trim())
    );
  }
}
