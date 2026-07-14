import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Response } from 'express';
import { Di, DiDocument } from './entities/di.entity';
import { GoogleDriveService } from 'src/google-drive/google-drive.service';

/**
 * Read-only image proxy for a DI's creation photo.
 *
 * The photo lives on Google Drive as a PRIVATE file, so the browser can't load
 * it directly (`<img src="drive.google.com/…/view">` is a viewer page, not the
 * bytes). This endpoint fetches the file server-side (authenticated Drive
 * client) and streams it back with its real content-type, so the Diagnostic /
 * Réparation modals can display it inline.
 *
 * GET /di/:id/image → the image bytes, or 404 when the DI has no Drive image
 * (legacy filename-only rows return 404 → the UI shows a clean fallback).
 * Serving only (no upload/model change); unauthenticated like the other static
 * assets (docs/) — the id is an opaque UUID.
 */
@Controller('di')
export class DiImageController {
  private readonly logger = new Logger(DiImageController.name);

  constructor(
    @InjectModel(Di.name) private readonly diModel: Model<DiDocument>,
    private readonly drive: GoogleDriveService,
  ) {}

  /**
   * Pull a Drive file id out of the various URL shapes Drive hands back
   * (`/file/d/{id}/view`, `?id={id}`, `/d/{id}`). Returns '' when the string
   * isn't a recognisable Drive URL (e.g. a legacy bare filename).
   */
  private extractDriveFileId(raw?: string): string {
    if (!raw) return '';
    const s = raw.toString().trim();
    const byPath = s.match(/\/(?:file\/)?d\/([A-Za-z0-9_-]{10,})/);
    if (byPath) return byPath[1];
    const byQuery = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    if (byQuery) return byQuery[1];
    return '';
  }

  @Get(':id/image')
  async getImage(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const di: any = await this.diModel
      .findOne({ _id: id })
      .select('driveDocs image')
      .lean();
    // Prefer the structured id; fall back to parsing the stored Drive URL so a
    // DI whose driveDocs.Image was never populated still serves its photo.
    const fileId =
      di?.driveDocs?.Image?.driveFileId || this.extractDriveFileId(di?.image);
    if (!fileId) {
      res.status(404).json({ message: 'Aucune image jointe' });
      return;
    }
    try {
      const { stream, mimeType } = await this.drive.downloadFile(fileId);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      stream.on('error', (err) => {
        this.logger.warn(`DI image stream error (${id}): ${err?.message}`);
        if (!res.headersSent) res.status(502).end();
      });
      stream.pipe(res);
    } catch (err) {
      this.logger.warn(
        `DI image proxy failed (${id}): ${(err as Error)?.message ?? err}`,
      );
      if (!res.headersSent) {
        res.status(502).json({ message: 'Image indisponible' });
      }
    }
  }
}
