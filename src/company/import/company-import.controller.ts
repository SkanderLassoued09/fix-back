import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
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
import { CompanyImportService } from './company-import.service';

/**
 * Surface REST (hors GraphQL) pour l'export/import xlsx des sociétés :
 *   GET  /company/export                 → toutes les sociétés (.xlsx)
 *   GET  /company/export/:id             → une société (.xlsx)
 *   GET  /company/import/template        → modèle vierge (.xlsx)
 *   POST /company/import?dryRun=true|false  multipart `file` (.xlsx)
 *        dryRun (défaut) = APERÇU sans écriture ; false = écriture réelle.
 */
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller('company')
export class CompanyImportController {
  constructor(private readonly importService: CompanyImportService) {}

  @Get('export')
  @UseGuards(RestJwtAuthGuard)
  async exportAll(@Res() res: Response) {
    const buffer = await this.importService.exportAll();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="societes.xlsx"');
    res.send(buffer);
  }

  @Get('export/:id')
  @UseGuards(RestJwtAuthGuard)
  async exportOne(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.importService.exportOne(id);
    if (!buffer) throw new NotFoundException('Société introuvable.');
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="societe_${id}.xlsx"`,
    );
    res.send(buffer);
  }

  @Get('import/template')
  @UseGuards(RestJwtAuthGuard)
  template(@Res() res: Response) {
    const buffer = this.importService.buildTemplate();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="modele_import_societes.xlsx"',
    );
    res.send(buffer);
  }

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
    const isDryRun = String(dryRun) !== 'false'; // défaut = aperçu SÛR
    return this.importService.run(file.buffer, { dryRun: isDryRun });
  }
}
