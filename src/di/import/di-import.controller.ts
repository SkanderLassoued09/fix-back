import {
  BadRequestException,
  Controller,
  Get,
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
  constructor(private readonly importService: DiImportService) {}

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
