import { Injectable } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import {
  DiArchive,
  DiArchiveDocType,
  DiArchiveOrigin,
  StatutCompletude,
} from './entities/di-archive.entity';
import { CreateDiArchiveInput } from './dto/create-di-archive.input';
import {
  DiArchivesFilterInput,
  DiArchivesPageInput,
} from './dto/di-archives-filter.input';
import { DiArchivePage } from './entities/di-archive-page.output';
import { buildArchiveFilter } from './di-archive-filter.util';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import { getFileExtension } from '../di/shared.files';

/** docType → (DiArchive field, Drive DocType used by buildDocFileName). */
const DOC_MAP: Record<DiArchiveDocType, { field: 'bc' | 'bl' | 'devis' | 'facture'; drive: 'BC' | 'BL' | 'Devis' | 'Facture' }> = {
  [DiArchiveDocType.BC]: { field: 'bc', drive: 'BC' },
  [DiArchiveDocType.BL]: { field: 'bl', drive: 'BL' },
  [DiArchiveDocType.DEVIS]: { field: 'devis', drive: 'Devis' },
  [DiArchiveDocType.FACTURE]: { field: 'facture', drive: 'Facture' },
};
const DOC_FIELDS: Array<'bc' | 'bl' | 'devis' | 'facture'> = ['bc', 'bl', 'devis', 'facture'];
/** Text-reference field paired with each document field. */
const REF_FIELD: Record<'bc' | 'bl' | 'devis' | 'facture', string> = {
  bc: 'bcRef',
  bl: 'blRef',
  devis: 'devisRef',
  facture: 'factureRef',
};

/** A doc is PRESENT when it has a Drive upload OR a text reference (from the file). */
function docPresent(doc: any, f: 'bc' | 'bl' | 'devis' | 'facture'): boolean {
  const ref = doc?.[REF_FIELD[f]];
  return doc?.[f] != null || !!(ref && String(ref).trim());
}

/** STRICT: the 4 docs all present ⇒ COMPLET, else INCOMPLET. */
function computeCompletude(doc: any): StatutCompletude {
  return DOC_FIELDS.every((f) => docPresent(doc, f))
    ? StatutCompletude.COMPLET
    : StatutCompletude.INCOMPLET;
}

/** Payload for the migration path — NOT a GraphQL input (never API-reachable). */
export interface MigrationArchiveInput {
  title: string;
  description?: string;
  numSerie?: string;
  arrangement?: string;
  clientNom?: string | null;
  societeNom?: string | null;
  refOrigine?: string | null;
  statutHistorique?: string | null;
  // Text references from the registry columns (BC / BL / Devis / Facture / Valid. Client).
  bcRef?: string | null;
  blRef?: string | null;
  devisRef?: string | null;
  factureRef?: string | null;
  validClient?: string | null;
}

/**
 * CRUD for archived DIs. Standalone — never touches the `Di` collection, and has
 * NO Discord / Stat / Sheets / cron dependency (side-effect-free by construction).
 */
@Injectable()
export class DiArchiveService {
  constructor(
    @InjectModel('DiArchive') private readonly diArchiveModel: Model<any>,
    private readonly googleDriveService: GoogleDriveService,
  ) {}

  // ── Document upload / removal + strict completude derivation ──────────────

  /**
   * Upload one document to Google Drive (reusing the shared `GoogleDriveService`
   * primitives + the `Di` folder/naming convention), store the returned
   * `DriveDocRef` in the matching field, then re-derive `statutCompletude`.
   *
   * Drive is done FIRST: if the upload throws, NO field is written and the
   * status is untouched (Drive is the single source of truth).
   */
  async uploadDoc(
    diArchiveId: string,
    docType: DiArchiveDocType,
    base64: string,
  ): Promise<DiArchive> {
    const archive = await this.diArchiveModel.findById(diArchiveId).lean();
    if (!archive) {
      throw new GraphQLError('DiArchive introuvable.', {
        extensions: { code: 'BAD_REQUEST', diArchiveId },
      });
    }
    const map = DOC_MAP[docType];
    const ref = await this.uploadToDrive(archive, map.drive, base64); // may throw → no write

    // Set the field on the FRESH doc, then derive completude from that fresh
    // state (concurrency-safe: reflects any parallel field writes).
    const updated = await this.diArchiveModel
      .findOneAndUpdate({ _id: diArchiveId }, { $set: { [map.field]: ref } }, { new: true })
      .lean();
    await this.applyDerivedCompletude(updated);
    return this.diArchiveModel.findById(diArchiveId).lean() as unknown as DiArchive;
  }

  /**
   * Unlink one document (field → null) and re-derive `statutCompletude`. The
   * Drive file itself is NOT deleted — only the reference is cleared (Drive stays
   * the archive; avoids accidental data loss, aligned with `Di`).
   */
  async removeDoc(
    diArchiveId: string,
    docType: DiArchiveDocType,
  ): Promise<DiArchive> {
    const map = DOC_MAP[docType];
    const updated = await this.diArchiveModel
      .findOneAndUpdate({ _id: diArchiveId }, { $set: { [map.field]: null } }, { new: true })
      .lean();
    if (!updated) {
      throw new GraphQLError('DiArchive introuvable.', {
        extensions: { code: 'BAD_REQUEST', diArchiveId },
      });
    }
    await this.applyDerivedCompletude(updated);
    return this.diArchiveModel.findById(diArchiveId).lean() as unknown as DiArchive;
  }

  /**
   * Clôture (admin/manager action) — COMPLET → CLOTURE (terminal). Only allowed
   * when the 4 documents are present. Idempotent if already CLOTURE.
   * (The role check is enforced on the front — the button only shows for
   * admin/manager, mirroring how the DI upload actions are gated.)
   */
  async cloture(diArchiveId: string): Promise<DiArchive> {
    const archive: any = await this.diArchiveModel.findById(diArchiveId).lean();
    if (!archive) {
      throw new GraphQLError('DiArchive introuvable.', {
        extensions: { code: 'BAD_REQUEST', diArchiveId },
      });
    }
    if (archive.statutCompletude === StatutCompletude.CLOTURE) {
      return archive as DiArchive; // idempotent
    }
    if (archive.statutCompletude !== StatutCompletude.COMPLET) {
      throw new GraphQLError(
        'Clôture impossible : les 4 documents (BC, BL, Devis, Facture) doivent être présents.',
        { extensions: { code: 'BAD_REQUEST', diArchiveId } },
      );
    }
    await this.diArchiveModel.updateOne(
      { _id: diArchiveId },
      { $set: { statutCompletude: StatutCompletude.CLOTURE } },
    );
    return this.diArchiveModel.findById(diArchiveId).lean() as unknown as DiArchive;
  }

  /**
   * STRICT rule: the 4 docs (bc/bl/devis/facture) all non-null ⇒ COMPLET, else
   * INCOMPLET. NEVER overwrites CLOTURE (terminal) — the DB filter `{ $ne:
   * CLOTURE }` guards it atomically, so a doc on a closed archive never flips it.
   */
  private async applyDerivedCompletude(doc: any): Promise<void> {
    if (!doc) return;
    // Present = Drive upload OR text reference from the file (see docPresent).
    const statut = computeCompletude(doc);
    await this.diArchiveModel.updateOne(
      { _id: doc._id, statutCompletude: { $ne: StatutCompletude.CLOTURE } },
      { $set: { statutCompletude: statut } },
    );
  }

  /**
   * Decode the base64 data-URL and upload it via `GoogleDriveService` (SAME
   * functions + naming convention as `Di`). Folder = client/société name (or
   * `SANS_CLIENT` fallback). Returns the `DriveDocRef` to store.
   */
  private async uploadToDrive(
    archive: any,
    driveDocType: 'BC' | 'BL' | 'Devis' | 'Facture',
    base64: string,
  ): Promise<{ driveFileId: string; webViewLink: string; name: string }> {
    const entityName =
      (archive.clientNom || archive.societeNom || '').trim() || 'SANS_CLIENT';
    const ext = getFileExtension(base64);
    const buffer = Buffer.from(base64.split(',')[1], 'base64');
    const mime = base64.split(',')[0]?.split(':')[1]?.split(';')[0];

    const folder = await this.googleDriveService.ensureEntityFolder(
      'client',
      entityName,
      (archive as any).createdAt ?? new Date(),
    );
    const fileName = this.googleDriveService.buildDocFileName(
      entityName,
      driveDocType,
      ext,
    );
    const uploaded = await this.googleDriveService.uploadFile(
      folder.id,
      fileName,
      buffer,
      mime,
    );
    return {
      driveFileId: uploaded.id,
      webViewLink: uploaded.webViewLink,
      name: fileName,
    };
  }

  /**
   * PUBLIC / MANUAL path (GraphQL `createDiArchive`). `origin` defaults to MANUAL
   * (schema); the migration fields (statutHistorique/origin/refOrigine/batchId)
   * are NOT settable here — the input doesn't expose them.
   */
  async create(input: CreateDiArchiveInput): Promise<DiArchive> {
    const doc = new this.diArchiveModel({ _id: `DIA_${uuidv4()}`, ...input });
    return (await doc.save()) as unknown as DiArchive;
  }

  /**
   * MIGRATION path — RESERVED to `DiArchiveImportService`, never exposed to the
   * API. Writes the historical status DIRECTLY as the final state (no cycle, no
   * guard — the operational transition guard lives only on `Di`) and stamps
   * `origin=MIGRATION` + `importBatchId`. Documents stay EMPTY; `statutCompletude`
   * defaults INCOMPLET. Side-effect-free: only `save()` runs.
   */
  async createFromMigration(
    input: MigrationArchiveInput,
    opts: { batchId: string },
  ): Promise<DiArchive> {
    const refs = {
      bcRef: input.bcRef ?? null,
      blRef: input.blRef ?? null,
      devisRef: input.devisRef ?? null,
      factureRef: input.factureRef ?? null,
    };
    const doc = new this.diArchiveModel({
      _id: `DIA_${uuidv4()}`,
      title: input.title,
      description: input.description,
      numSerie: input.numSerie,
      arrangement: input.arrangement,
      clientNom: input.clientNom ?? null,
      societeNom: input.societeNom ?? null,
      refOrigine: input.refOrigine ?? null,
      statutHistorique: input.statutHistorique ?? null,
      ...refs,
      validClient: input.validClient ?? null,
      // Complétude dérivée dès l'import à partir des réfs texte (uploads encore
      // vides) : les 4 réfs présentes ⇒ COMPLET, sinon INCOMPLET (à uploader).
      statutCompletude: computeCompletude(refs),
      origin: DiArchiveOrigin.MIGRATION,
      importBatchId: opts.batchId,
    });
    return (await doc.save()) as unknown as DiArchive;
  }

  /** Migration refOrigines already in DB — the idempotence key set. */
  async existingMigrationRefs(): Promise<Set<string>> {
    const rows = await this.diArchiveModel
      .find(
        { origin: DiArchiveOrigin.MIGRATION, refOrigine: { $type: 'string' } },
        { refOrigine: 1 },
      )
      .lean();
    return new Set(rows.map((r: any) => r.refOrigine));
  }

  async findAll(): Promise<DiArchive[]> {
    return this.diArchiveModel
      .find()
      .sort({ createdAt: -1 })
      .lean() as unknown as Promise<DiArchive[]>;
  }

  /** Whitelist of columns a client may sort on (guards against injection). */
  private static readonly SORTABLE = new Set([
    'refOrigine',
    'title',
    'numSerie',
    'clientNom',
    'societeNom',
    'statutHistorique',
    'statutCompletude',
    'arrangement',
    'createdAt',
    'updatedAt',
  ]);

  /**
   * Server-side page for `/archives`: applies the cumulative filter
   * ([[di-archive-filter.util]] · buildArchiveFilter), then counts + fetches ONE
   * page. `count` and `find` share the SAME query so the total always matches
   * the rows. Never loads the whole (~1400-row) collection into memory.
   */
  async findPage(
    filter?: DiArchivesFilterInput,
    page?: DiArchivesPageInput,
  ): Promise<DiArchivePage> {
    const query = buildArchiveFilter(filter);
    const limit = Math.min(Math.max(page?.limit ?? 12, 1), 200);
    const pageNum = Math.max(page?.page ?? 1, 1);
    const skip = (pageNum - 1) * limit;
    const sortField =
      page?.sortField && DiArchiveService.SORTABLE.has(page.sortField)
        ? page.sortField
        : 'createdAt';
    const sortOrder = page?.sortOrder === 1 ? 1 : -1;

    const [rows, totalCount] = await Promise.all([
      this.diArchiveModel
        .find(query)
        .sort({ [sortField]: sortOrder })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.diArchiveModel.countDocuments(query),
    ]);
    return { rows: rows as unknown as DiArchive[], totalCount };
  }

  /**
   * Distinct non-empty historical statuses — powers the « Statut » dropdown so
   * it self-populates from whatever vocabulary the registry actually contains
   * (returns `[]` while `statutHistorique` is unset on every row).
   */
  async distinctStatutsHistorique(): Promise<string[]> {
    const values: unknown[] = await this.diArchiveModel.distinct(
      'statutHistorique',
      { statutHistorique: { $nin: [null, ''] } },
    );
    return (values as string[])
      .filter((v) => v != null && String(v).trim() !== '')
      .sort((a, b) => a.localeCompare(b));
  }

  async findOne(_id: string): Promise<DiArchive | null> {
    return this.diArchiveModel
      .findById(_id)
      .lean() as unknown as Promise<DiArchive | null>;
  }
}
