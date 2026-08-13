import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { RestJwtAuthGuard } from 'src/auth/rest-jwt-auth-guard';
import { DiImportService } from './di-import.service';
import { DiImportJobService } from './di-import-job.service';

/**
 * REST surface for the bulk DI import (multipart — outside GraphQL).
 *
 *   POST /di/import?dryRun=true|false   multipart field `file` (.xlsx)
 *   GET  /di/import/template            streams the .xlsx model
 *
 * Auth: `RestJwtAuthGuard` (Bearer token, same as the GraphQL API). The import
 * never notifies Discord (handled in the service via `skipNotify`), so there is
 * no `x-test-run` side-effect to suppress here.
 */
@Controller('di')
export class DiImportController {
  constructor(
    private readonly importService: DiImportService,
    private readonly jobService: DiImportJobService,
  ) {}

  @Post('import')
  @UseGuards(RestJwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      // In-memory (default) — a backlog import is small. 8 MB hard cap.
      limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    }),
  )
  async import(
    @UploadedFile() file: { originalname?: string; buffer?: Buffer } | undefined,
    @Query('dryRun') dryRun: string,
    @Req() req: Request,
  ) {
    if (!file || !file.buffer) {
      throw new BadRequestException('Fichier manquant (champ « file »).');
    }
    if (!/\.xlsx$/i.test(file.originalname ?? '')) {
      throw new BadRequestException('Format invalide : un fichier .xlsx est attendu.');
    }
    // Default to the SAFE dry-run; only an explicit `dryRun=false` persists.
    const isDryRun = String(dryRun) !== 'false';
    const createdBy = (req as any)?.user?._id;
    return this.importService.run(file.buffer, { dryRun: isDryRun, createdBy });
  }

  /**
   * Exécution ASYNCHRONE en JOB : démarre le traitement par lots côté serveur et
   * renvoie IMMÉDIATEMENT `{ jobId, total }`. La progression arrive via le WS
   * `di-import.progress` (filtré par `jobId`) et l'état persiste dans
   * `di_import_jobs` (consultable après fermeture d'onglet). Le chemin synchrone
   * `POST /di/import?dryRun=false` reste inchangé (non-régression).
   */
  @Post('import/execute')
  @UseGuards(RestJwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    }),
  )
  async execute(
    @UploadedFile() file: { originalname?: string; buffer?: Buffer } | undefined,
    @Req() req: Request,
  ) {
    if (!file || !file.buffer) {
      throw new BadRequestException('Fichier manquant (champ « file »).');
    }
    if (!/\.xlsx$/i.test(file.originalname ?? '')) {
      throw new BadRequestException('Format invalide : un fichier .xlsx est attendu.');
    }
    const createdBy = (req as any)?.user?._id;
    // Décisions d'ambiguité (résolutions « both ») transmises en champ `decisions`
    // du multipart (JSON). Tolérant : format invalide → ignoré (aucune décision).
    let decisions: Array<{ ligne: number; kind: 'client' | 'company' }> = [];
    const rawDecisions = (req as any)?.body?.decisions;
    if (rawDecisions) {
      try {
        const parsed = JSON.parse(rawDecisions);
        if (Array.isArray(parsed)) decisions = parsed;
      } catch {
        /* champ malformé → aucune décision appliquée */
      }
    }
    return this.importService.executeAsJob(file.buffer, { createdBy, decisions });
  }

  /**
   * Récupération d'un job (reconnexion/réouverture). SÉCURISÉ : un utilisateur
   * ne récupère QUE ses propres jobs (`getForUser` → Forbidden sinon).
   */
  @Get('import/jobs/:jobId')
  @UseGuards(RestJwtAuthGuard)
  async job(@Param('jobId') jobId: string, @Req() req: Request) {
    const userId = (req as any)?.user?._id;
    return this.jobService.getForUser(jobId, userId);
  }

  @Get('import/template')
  @UseGuards(RestJwtAuthGuard)
  template(@Res() res: Response) {
    const buffer = this.importService.buildTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="modele_import_di.xlsx"',
    );
    res.send(buffer);
  }
}
