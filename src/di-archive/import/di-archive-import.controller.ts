import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { RestJwtAuthGuard } from 'src/auth/rest-jwt-auth-guard';
import { DiArchiveImportService } from './di-archive-import.service';

/**
 * REST surface for the SEPARATE archive import (multipart — outside GraphQL).
 * Mirrors the operational DI import endpoint but targets `DiArchive`.
 *
 *   POST /di-archive/import?dryRun=true|false   multipart field `file` (.xlsx)
 *   GET  /di-archive/import/template            streams the .xlsx model
 */
@Controller('di-archive')
export class DiArchiveImportController {
  constructor(private readonly importService: DiArchiveImportService) {}

  @Post('import')
  @UseGuards(RestJwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }),
  )
  async import(
    @UploadedFile() file: { originalname?: string; buffer?: Buffer } | undefined,
    @Query('dryRun') dryRun: string,
  ) {
    if (!file || !file.buffer) {
      throw new BadRequestException('Fichier manquant (champ « file »).');
    }
    if (!/\.xlsx$/i.test(file.originalname ?? '')) {
      throw new BadRequestException('Format invalide : un fichier .xlsx est attendu.');
    }
    const isDryRun = String(dryRun) !== 'false'; // default = SAFE dry-run
    return this.importService.run(file.buffer, { dryRun: isDryRun });
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
      'attachment; filename="modele_import_di_archive.xlsx"',
    );
    res.send(buffer);
  }
}
