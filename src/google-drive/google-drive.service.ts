import { Injectable, Logger } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';

export interface DriveFolder {
  id: string;
  webViewLink: string;
}

/**
 * Thin Google Drive v3 client — reuses the SAME service-account credentials as
 * the Sheets integration (`GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`),
 * just with the Drive scope added.
 *
 * ⚠️ A service account has **no personal Drive quota**, so folders MUST be
 * created inside a **Shared Drive** the SA is a member of (Content manager),
 * via `GOOGLE_DRIVE_PARENT_FOLDER_ID` (+ `supportsAllDrives: true`). Otherwise
 * `files.create` fails with `storageQuotaExceeded`. See
 * `.project-context/decisions/04-google-drive-client-folders.md`.
 */
@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);
  private drive: drive_v3.Drive | null = null;

  private async ensureClient(): Promise<drive_v3.Drive> {
    if (this.drive) return this.drive;

    const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    // GOOGLE_PRIVATE_KEY stores newlines as literal `\n` in .env (single line);
    // restore real newlines before the JWT signer sees the PEM (same as Sheets).
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!clientEmail || !privateKey) {
      throw new Error(
        'Google credentials missing — set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY in .env',
      );
    }

    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey },
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    this.drive = google.drive({ version: 'v3', auth });
    return this.drive;
  }

  /**
   * Build the folder name: `{client} {DD/MM/YYYY HH:mm:ss}` in the configured
   * timezone (default `Africa/Tunis`). The date format is configurable via
   * `DRIVE_FOLDER_DATE_FORMAT` (e.g. `YYYY-MM-DD_HH-mm-ss` for desktop-sync
   * safety — `/` and `:` are illegal filename chars on Windows/macOS, though
   * the Drive API itself accepts them). Only the client-name part is sanitized.
   *
   * → `Skander LASSOUED 11/06/2026 15:16:20`
   */
  buildFolderName(clientName: string, createdAt: Date): string {
    const tz = process.env.APP_TIMEZONE || 'Africa/Tunis';
    const fmt = process.env.DRIVE_FOLDER_DATE_FORMAT || 'DD/MM/YYYY HH:mm:ss';
    return `${this.sanitizeName(clientName)} ${this.formatTimestamp(
      createdAt,
      tz,
      fmt,
    )}`;
  }

  /** Trim, collapse whitespace, drop control chars (codepoints < 32 and 127). */
  private sanitizeName(clientName: string): string {
    const cleaned = (clientName || '')
      .split('')
      .filter((ch) => {
        const code = ch.charCodeAt(0);
        return code >= 32 && code !== 127;
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || 'Client';
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

  /**
   * Create the client folder under the configured parent (Shared-Drive aware).
   * Throws on misconfiguration / API error — callers treat Drive as best-effort
   * and must NOT let a failure block the business flow.
   */
  async createClientFolder(
    clientName: string,
    createdAt: Date,
  ): Promise<DriveFolder> {
    const parent = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
    if (!parent) {
      throw new Error(
        'GOOGLE_DRIVE_PARENT_FOLDER_ID is required to create client folders',
      );
    }

    const drive = await this.ensureClient();
    const name = this.buildFolderName(clientName, createdAt);

    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parent],
      },
      fields: 'id, webViewLink',
      // Required whenever the parent lives in a Shared Drive.
      supportsAllDrives: true,
    });

    const id = res.data.id;
    if (!id) {
      throw new Error('Drive folder create returned no id');
    }
    this.logger.log(`Created client Drive folder "${name}" (${id})`);
    return { id, webViewLink: res.data.webViewLink ?? '' };
  }
}
