import {
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  CreateDiInput,
  DiagUpdate,
  FilterConfigDi,
  PaginationConfigDi,
  UpdateDi,
} from './dto/create-di.input';
import { InjectModel } from '@nestjs/mongoose';
import { Di, DiDocument, UpdateNego } from './entities/di.entity';
import { Model } from 'mongoose';
import {
  MAGASIN_STATUS_DI_VALUES,
  STATUS_DI,
  TECH_STATUS_DI_VALUES,
} from './di.status';
import { GraphQLError } from 'graphql';
import { assertDiTransition } from './workflow/di-transition-guard';
import { Role } from 'src/auth/roles';
import {
  Composant,
  ComposantDocument,
} from 'src/composant/entities/composant.entity';
import { error, log } from 'console';
import {
  Remarque,
  RemarqueDocument,
} from 'src/remarque/entities/remarque.entity';
import { StatService } from 'src/stat/stat.service';
import { NotFoundError } from 'rxjs';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';
import * as randomstring from 'randomstring';
import { join } from 'path';
import * as fs from 'fs';
import { getFileExtension } from './shared.files';
import { AuditService } from 'src/audit/audit.service';
import { AuditInput } from 'src/audit/dto/create-audit.input';
import { Stat } from 'src/stat/entities/stat.entity';
import * as moment from 'moment';
import { LogsDiService } from 'src/logs-di/logs-di.service';
import { nanoid } from 'nanoid';
import { Profile, ProfileDocument } from 'src/profile/entities/profile.entity';
import { Company, CompanyDocument } from 'src/company/entities/company.entity';
import { Client, ClientDocument } from 'src/clients/entities/client.entity';
import {
  Location,
  LocationDocument,
} from 'src/location/entities/location.entity';
import { DiscordHook } from 'src/discord-hook/entities/discord-hook.entity';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { DiWorkflowService } from './workflow/di-workflow.service';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';
import {
  GoogleDriveService,
  DriveDocType,
} from 'src/google-drive/google-drive.service';
@Injectable()
export class DiService {
  constructor(
    @InjectModel(Di.name) private diModel: Model<DiDocument>,
    @InjectModel(Profile.name) private profileModel: Model<ProfileDocument>,
    @InjectModel(Company.name) private companyModel: Model<CompanyDocument>,
    @InjectModel(Client.name) private clientModel: Model<ClientDocument>,
    @InjectModel(Location.name) private locationModel: Model<LocationDocument>,

    @InjectModel(Composant.name)
    private composantModel: Model<ComposantDocument>,
    @InjectModel(Remarque.name)
    private readonly remarqueModel: Model<RemarqueDocument>,
    private readonly profileService: ProfileService,
    @InjectModel(Stat.name)
    private readonly statModel: Model<Stat>,
    private readonly statsService: StatService,
    private readonly notificationGateway: NotificationsGateway,
    private readonly auditService: AuditService,
    private readonly logsDiService: LogsDiService,
    private readonly discordHookService: DiscordHookService,
    private readonly diWorkflowService: DiWorkflowService,
    private readonly operationalErrorService: OperationalErrorService,
    private readonly googleDriveService: GoogleDriveService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // Drive uploads — every DI document (image, BC, Devis, BL, Facture) is
  // renamed to a standard scheme and stored in the DI's entity folder
  // (CLIENTS/company/{name} or CLIENTS/client/{name}). Drive is the single
  // source — no local docs/ storage.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Resolve the target Drive folder for a DI from its linked entity (company OR
   * client — a DI targets exactly one). Ensures the entity folder exists
   * (idempotent) and returns `{ folderId, entityName }`. Throws a clean error
   * when no entity is linked. The entity may carry no `driveFolderId` yet (e.g.
   * created while Drive was down) → we (re)create it here on demand.
   */
  /**
   * A ref id counts as "set" only when it's a non-empty string that isn't a
   * stringified null/undefined. The front sends `company_id: "null"` (the
   * literal string) for a CLIENT-type DI's unused company field (and vice
   * versa) — treating that as a real id sent the resolver down the company
   * branch, where `findById("null")` returned null → the
   * `Company 'null' not found` crash. This guard picks the correct entity.
   */
  private isResolvableId(v: unknown): v is string {
    return (
      typeof v === 'string' &&
      v.trim() !== '' &&
      v !== 'null' &&
      v !== 'undefined'
    );
  }

  /**
   * In-process per-entity lock for `resolveDiDriveTarget`. When two DIs are
   * created near-simultaneously for the same client/company AND the entity has
   * no `driveFolderId` yet, both calls used to read null, both called
   * `ensureEntityFolder`, and Drive happily produced two folders. We now share
   * the same in-flight Promise across racers on the same key
   * (`company:{id}` / `client:{id}`); the second caller awaits the first's
   * result instead of starting a parallel create. The entry is deleted as soon
   * as the Promise settles (success OR failure) so a failed call doesn't
   * poison the lock indefinitely. Single-process scope — `ensureEntityFolder`
   * is also idempotent by name (see google-drive.service.ts) so concurrent
   * Node instances converge on the same folder too.
   */
  private readonly _driveTargetInFlight = new Map<
    string,
    Promise<{ folderId: string; entityName: string }>
  >();

  private async resolveDiDriveTarget(
    di: any,
    opts: { forceRecreate?: boolean } = {},
  ): Promise<{ folderId: string; entityName: string }> {
    const companyId = this.isResolvableId(di?.company_id) ? di.company_id : null;
    const clientId = this.isResolvableId(di?.client_id) ? di.client_id : null;
    const key = companyId
      ? `company:${companyId}`
      : clientId
        ? `client:${clientId}`
        : null;

    // forceRecreate must bypass the in-flight cache: an auto-repair call after
    // a real 404 must NOT return a parallel pre-repair folder.
    if (!opts.forceRecreate && key) {
      const inFlight = this._driveTargetInFlight.get(key);
      if (inFlight) return inFlight;
    }

    const work = this._resolveDiDriveTargetUncached(di, opts);
    if (!opts.forceRecreate && key) {
      this._driveTargetInFlight.set(key, work);
      // Two-arg `then` (not `.finally`) so a rejection on `work` doesn't fork
      // a second unhandled rejection on the cleanup chain — the original
      // `work` Promise still surfaces the error to its own awaiter.
      void work.then(
        () => this._driveTargetInFlight.delete(key),
        () => this._driveTargetInFlight.delete(key),
      );
    }
    return work;
  }

  private async _resolveDiDriveTargetUncached(
    di: any,
    opts: { forceRecreate?: boolean } = {},
  ): Promise<{ folderId: string; entityName: string }> {
    const companyId = this.isResolvableId(di?.company_id) ? di.company_id : null;
    const clientId = this.isResolvableId(di?.client_id) ? di.client_id : null;
    // forceRecreate = the stored folder is stale (404) → ignore it and make a
    // fresh one, overwriting the stale id below.
    const reuse = !opts.forceRecreate;

    if (companyId) {
      const company: any = await this.companyModel.findById(companyId).lean();
      if (!company) {
        throw new GraphQLError(`Société introuvable (id ${companyId}).`, {
          extensions: { code: 'BAD_REQUEST' },
        });
      }
      const name = company.raisonSociale || company.name || 'Company';
      if (reuse && company.driveFolderId) {
        return { folderId: company.driveFolderId, entityName: name };
      }
      const folder = await this.googleDriveService.ensureEntityFolder(
        'company',
        name,
        company.createdAt ?? new Date(),
      );
      // Conditional write: only persist OUR id when the slot is still
      // empty/stale. If another writer (or process) won the race, re-read and
      // prefer their stored id — `ensureEntityFolder` is idempotent by name so
      // both racers obtained the same Drive folder anyway, but this keeps the
      // stored id stable across processes.
      const filter: any = reuse
        ? { _id: company._id, $or: [{ driveFolderId: null }, { driveFolderId: { $exists: false } }, { driveFolderId: '' }] }
        : { _id: company._id };
      const res: any = await this.companyModel.updateOne(filter, {
        $set: { driveFolderId: folder.id, driveFolderUrl: folder.webViewLink },
      });
      if (reuse && (res?.matchedCount ?? res?.n) === 0) {
        const winner: any = await this.companyModel.findById(company._id).lean();
        if (winner?.driveFolderId) {
          return { folderId: winner.driveFolderId, entityName: name };
        }
      }
      return { folderId: folder.id, entityName: name };
    }

    if (clientId) {
      const client: any = await this.clientModel.findById(clientId).lean();
      if (!client) {
        throw new GraphQLError(`Client introuvable (id ${clientId}).`, {
          extensions: { code: 'BAD_REQUEST' },
        });
      }
      const name = `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim();
      if (reuse && client.driveFolderId) {
        return { folderId: client.driveFolderId, entityName: name };
      }
      const folder = await this.googleDriveService.ensureEntityFolder(
        'client',
        name,
        client.createdAt ?? new Date(),
      );
      const filter: any = reuse
        ? { _id: client._id, $or: [{ driveFolderId: null }, { driveFolderId: { $exists: false } }, { driveFolderId: '' }] }
        : { _id: client._id };
      const res: any = await this.clientModel.updateOne(filter, {
        $set: { driveFolderId: folder.id, driveFolderUrl: folder.webViewLink },
      });
      if (reuse && (res?.matchedCount ?? res?.n) === 0) {
        const winner: any = await this.clientModel.findById(client._id).lean();
        if (winner?.driveFolderId) {
          return { folderId: winner.driveFolderId, entityName: name };
        }
      }
      return { folderId: folder.id, entityName: name };
    }

    // No resolvable company OR client. Expected user/data condition (not a 500):
    // a clean BAD_REQUEST → the global filter logs it LOW with NO Discord alert,
    // and the FE shows the message as a toast.
    throw new GraphQLError(
      "Cette DI n'est rattachée à aucune société ni client — impossible de classer le fichier sur Drive.",
      { extensions: { code: 'BAD_REQUEST' } },
    );
  }

  /**
   * Decode a base64 data-URL, upload it to the DI's entity Drive folder under
   * the standardized name `{Name}_{DocType}_{date}_{heure}.{ext}`, and return
   * the Drive `webViewLink` (stored on the DI) + `driveFileId`. Throws on any
   * failure (Drive misconfigured, no entity, API error) so callers surface a
   * clear error instead of a fake success — Drive is the single source.
   */
  private async uploadDiDocToDrive(
    di: any,
    base64: string,
    docType: DriveDocType,
  ): Promise<{ webViewLink: string; driveFileId: string; fileName: string }> {
    const ext = getFileExtension(base64);
    const buffer = Buffer.from(base64.split(',')[1], 'base64');
    const mime = base64.split(',')[0]?.split(':')[1]?.split(';')[0];

    const target = await this.resolveDiDriveTarget(di);
    const fileName = this.googleDriveService.buildDocFileName(
      target.entityName,
      docType,
      ext,
    );

    let uploaded;
    try {
      uploaded = await this.googleDriveService.uploadFile(
        target.folderId,
        fileName,
        buffer,
        mime,
      );
    } catch (err) {
      // AUTO-REPAIR: the stored driveFolderId is stale (created by the old
      // service account, or deleted) → Drive 404. Recreate the folder under the
      // OAuth account (overwriting the stale id) and retry the upload ONCE. Any
      // other error, or a second failure, propagates.
      if (!this.googleDriveService.isNotFoundError(err)) throw err;
      const fresh = await this.resolveDiDriveTarget(di, { forceRecreate: true });
      await this.operationalErrorService.capture({
        module: 'di',
        submodule: 'drive',
        method: 'DRIVE_FOLDER_AUTO_REPAIR',
        severity: 'LOW',
        error: 'Stale driveFolderId recreated under OAuth',
        message: `entity folder was 404; recreated (${target.folderId} → ${fresh.folderId})`,
        notify: false,
        payload: {
          diId: di?._id,
          companyId: di?.company_id,
          clientId: di?.client_id,
        },
      });
      uploaded = await this.googleDriveService.uploadFile(
        fresh.folderId,
        fileName,
        buffer,
        mime,
      );
    }

    return {
      webViewLink: uploaded.webViewLink,
      driveFileId: uploaded.id,
      fileName,
    };
  }

  /**
   * Migration helper: clear `driveFolderId`/`driveFolderUrl` on ALL companies
   * and clients so the NEXT upload recreates the folder under the new (OAuth)
   * account. The old folders were created by the SERVICE ACCOUNT in a different
   * Drive → unreachable under OAuth (`File not found`). Idempotent: only touches
   * rows that still carry a stale id; the lazy recreation in resolveDiDriveTarget
   * does the rest. Returns how many of each were reset.
   */
  async resetAllDriveFolders(): Promise<{ companies: number; clients: number }> {
    const clear = { $set: { driveFolderId: null, driveFolderUrl: null } };
    const filter = { driveFolderId: { $nin: [null, ''] } };
    const [c, cl] = await Promise.all([
      this.companyModel.updateMany(filter as any, clear),
      this.clientModel.updateMany(filter as any, clear),
    ]);
    const companies = (c as any)?.modifiedCount ?? 0;
    const clients = (cl as any)?.modifiedCount ?? 0;
    return { companies, clients };
  }

  /**
   * Tiny helper used at every Discord-side-effect site. Discord failures
   * are SWALLOWED (Discord is best-effort, never blocks a mutation) but
   * routed through the OperationalErrorService so they land in the daily
   * log file + the Discord ops channel. Keeps the 28 catch-Discord sites
   * to a single readable line each.
   */
  private async captureDiscordFailure(
    method: string,
    err: unknown,
    payload?: Record<string, any>,
  ) {
    await this.operationalErrorService.capture({
      module: 'di',
      submodule: 'diService',
      method,
      severity: 'LOW',
      error: 'Discord notification failed',
      message: (err as Error)?.message ?? String(err),
      payload,
    });
  }

  /**
   * Capture a document-upload failure at the RIGHT severity. An entity-
   * resolution problem surfaces as a GraphQLError carrying `extensions.code`
   * (e.g. BAD_REQUEST) — an EXPECTED user/data condition: log LOW, NO Discord.
   * A real Drive/API failure has no such code → HIGH + Discord. The caller
   * re-throws the (clean) error so the FE shows the exact message; the global
   * filter keys off the same code, so there's no duplicate HIGH alert.
   */
  private async captureUploadFailure(
    method: string,
    err: unknown,
    diId: string,
  ) {
    const expected = !!(err as any)?.extensions?.code;
    await this.operationalErrorService.capture({
      module: 'di',
      submodule: 'drive',
      method,
      severity: expected ? 'LOW' : 'HIGH',
      error: expected
        ? 'Upload skipped: DI entity unresolvable'
        : 'Drive upload failed',
      message: (err as Error)?.message ?? String(err),
      notify: !expected,
      payload: { diId },
    });
  }

  /**
   * Helper for the historically silent `.catch(err => err)` sites. We now
   * capture the failure and the caller returns a safe default (usually `[]`)
   * so the resolver never returns an Error object to the FE.
   */
  private async captureSilentFailure(
    method: string,
    err: unknown,
    payload?: Record<string, any>,
  ) {
    await this.operationalErrorService.capture({
      module: 'di',
      submodule: 'diService',
      method,
      severity: 'HIGH',
      error: 'Query failed (was previously swallowed)',
      message: (err as Error)?.message ?? String(err),
      payload,
    });
  }

  /**
   * Next DI number for the `_idnum` (`DI{n}`). HARDENED: only `_idnum` matching
   * `^DI\d+$` count — QA/legacy junk ids (`INMAG-…`, `LIFE-…`, even a previous
   * `DINaN`) are IGNORED so the parse can never yield `NaN`. Next = max(valid)+1,
   * fallback 1 when none. The old version read the most-recent DI's `_idnum` and
   * did `+substring(2)`; a single non-conforming id there produced `DINaN` and
   * poisoned every subsequent creation.
   */
  async generateClientId(): Promise<number> {
    const rows = await this.diModel
      .find({ _idnum: { $regex: '^DI[0-9]+$' } }, { _idnum: 1 })
      .lean();
    let max = 0;
    for (const r of rows) {
      const n = parseInt(String((r as any)?._idnum).slice(2), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1; // ≥ 1 → never `DI` + `NaN`, never collides with the max
  }

  async createDi(createDiInput: CreateDiInput): Promise<any> {
    try {
      // 🆔 Generate IDs
      const index = await this.generateClientId();
      createDiInput._id = `DI_${nanoid(4)}`;
      createDiInput._idnum = `DI${index}`;

      // 🖼️ Handle image — uploaded to the DI's entity Drive folder (Drive-only,
      // no local docs/). BEST-EFFORT here: an upload failure must NOT block DI
      // creation (unlike the standalone addBC/addDevis/… mutations which surface
      // the error). On failure we drop the image and keep going.
      let imageRef:
        | { driveFileId: string; webViewLink: string; name: string }
        | null = null;
      const rawImage = createDiInput.image?.includes(',')
        ? createDiInput.image
        : null;
      if (rawImage) {
        try {
          const { webViewLink, driveFileId, fileName } =
            await this.uploadDiDocToDrive(createDiInput, rawImage, 'Image');
          createDiInput.image = webViewLink;
          imageRef = { driveFileId, webViewLink, name: fileName };
        } catch (err) {
          createDiInput.image = null;
          await this.operationalErrorService.capture({
            module: 'di',
            submodule: 'drive',
            method: 'CREATE_DI_IMAGE_UPLOAD',
            severity: 'MEDIUM',
            error: 'DI image Drive upload failed (DI still created)',
            message: (err as Error)?.message ?? String(err),
            payload: {
              companyId: createDiInput?.company_id,
              clientId: createDiInput?.client_id,
            },
          });
        }
      }

      // 💾 Save
      const diDoc = new this.diModel(createDiInput);
      if (imageRef) (diDoc as any).driveDocs = { Image: imageRef };
      const di = await diDoc.save();
      await this.syncEmplacementStats(di.location_id as any);

      // 🔔 Notify (only if pending)
      if (di.status === 'PENDING1') {
        this.discordHookService.sendDiPendingNotification(di);
      }

      return di;
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'di',
        submodule: 'diService',
        method: 'CREATEDI',
        severity: 'HIGH',
        error: 'Failed to create DI',
        message: (error as Error)?.message ?? String(error),
        payload: {
          clientId: createDiInput?.client_id,
          companyId: createDiInput?.company_id,
          createdBy: createDiInput?.createdBy,
          title: createDiInput?.title,
        },
      });
      // Re-throw ORIGINAL error so callers see the real underlying cause
      // (Mongo write conflict, validation, etc.) instead of a generic wrap.
      throw error;
    }
  }

  /**
   * async findOneClient(_id: string): Promise<Client> {
    try {
      const Client = await this.ClientModel.findById(_id).lean();

      if (!Client) {
        throw new Error(`Client with ID '${_id}' not found.`);
      }
      return Client;
    } catch (error) {
      throw error;
    }
  }
   */
  async getDiById(_id: string) {
    try {
      // Fetch the Demande d'intervention (di) by ID
      const di = await this.diModel.findOne({ _id });
      if (!di) {
        throw new Error(`Demande d'intervention with ID '${_id}' not found.`);
      }

      // Initialize logsDi to null and only fetch if needed
      let logsDi = null;
      if (di && di.ignoreCount && di.ignoreCount > 0) {
        logsDi = [];
        for (let index = 1; index <= di.ignoreCount; index++) {
          // Push each logDi to the logsDi array
          const log = await this.logsDiService.getLogsById(index, di._id);
          logsDi.push(log);
        }
      }

      // Return the result
      return { logsDi, di };
    } catch (error) {
      throw error;
    }
  }

  async findbyId(_id: string) {
    return await this.diModel.findById({ _id });
  }

  async deleteDi(_id: string) {
    const existing = await this.diModel.findOne({ _id }).select('location_id');
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          isDeleted: true,
        },
      },
    );

    if (result.matchedCount === 0) {
      throw new NotFoundException(`Unable to delete DI ${_id}`);
    }
    await this.statsService.deleteStat(_id);
    await this.syncEmplacementStats(existing?.location_id as any);
    return await this.findbyId(_id);
  }

  async getAllNotOpeneddi() {
    return await this.diModel.find({ isOpenedOnce: false });
  }

  async addDevisPDF(_id: string, pdf: string) {
    try {
      const di = await this.diModel.findOne({ _id });
      if (!di) throw new Error(`DI '${_id}' not found`);

      // Drive-only: rename + upload to the DI's entity folder; store the link.
      const { webViewLink, driveFileId, fileName } =
        await this.uploadDiDocToDrive(di, pdf, 'Devis');

      let result;

      if (di.ignoreCount && di.ignoreCount > 0) {
        result = await this.logsDiService.addDevisPDFLogs(
          di._id,
          di.ignoreCount,
          webViewLink,
        );
      } else {
        result = await this.diModel.updateOne(
          { _id },
          {
            $set: {
              devis: webViewLink,
              'driveDocs.Devis': { driveFileId, webViewLink, name: fileName },
            },
          },
        );
      }

      // 🔔 Discord notification (Devis uploaded)
      try {
        await this.discordHookService.sendDiDevisUploaded({
          di,
          fileName,
        });
      } catch (err) {
        await this.captureDiscordFailure('addDevisPDF', err, { diId: _id });
      }

      // Return the fresh DI (the mutation is typed `() => Di`); `result` is a
      // Mongo update/log result with no Di fields.
      return await this.diModel.findOne({ _id });
    } catch (error) {
      await this.captureUploadFailure('ADD_DEVIS_PDF', error, _id);
      throw error;
    }
  }

  async addBlPDF(_id: string, pdf: string) {
    try {
      const di = await this.diModel.findOne({ _id });
      if (!di) throw new Error(`DI '${_id}' not found`);

      const { webViewLink, driveFileId, fileName } =
        await this.uploadDiDocToDrive(di, pdf, 'BL');

      if (di.ignoreCount && di.ignoreCount > 0) {
        await this.logsDiService.addBLPDFLogs(
          di._id,
          di.ignoreCount,
          webViewLink,
        );
        this.notificationGateway.blAddedNotification({
          di,
          message: `A new BL has been added for DI ${di._idnum} with ignore count ${di.ignoreCount}`,
        });
        // Also broadcast updateTicket so every ticket-list view triggers
        // its standard requestRefresh/loadData pipeline. Without this, the
        // BL flow only fires the bl-specific subject and depends solely on
        // the in-place patchBlAddedRow patch. The server-driven refresh
        // fetches the persisted state and lets the row's class binding
        // pick up bon_de_livraison from the DI document.
        this.notificationGateway.updateTicket({
          action: 'updateState',
          content: { result: di, states: di },
          target: {},
        });

        try {
          await this.discordHookService.sendDiBLUploaded({ di, fileName });
        } catch (err) {
          await this.captureDiscordFailure('addBlPDF', err, { diId: _id });
        }

        // Return the fresh DI (mutation is typed `() => Di`); addbllogspdf is
        // a LogsDi, not a Di.
        return await this.diModel.findOne({ _id });
      } else {
        // Use findOneAndUpdate({ new: true }) so the post-update document
        // (with bon_de_livraison populated) is what we both broadcast and
        // return. The previous updateOne left `di` as the pre-update doc,
        // so any consumer of the WS payload received stale data.
        const updatedDi = await this.diModel.findOneAndUpdate(
          { _id },
          {
            $set: {
              bon_de_livraison: webViewLink,
              'driveDocs.BL': { driveFileId, webViewLink, name: fileName },
            },
          },
          { new: true },
        );

        this.notificationGateway.blAddedNotification({
          di: updatedDi,
          message: {
            role: 'MAGASIN',
            content: `A new BL has been added for DI ${di._idnum}`,
          },
        });
        this.notificationGateway.updateTicket({
          action: 'updateState',
          content: { result: updatedDi, states: updatedDi },
          target: {},
        });

        try {
          await this.discordHookService.sendDiBLUploaded({
            di: updatedDi,
            fileName,
          });
        } catch (err) {
          await this.captureDiscordFailure('addBlPDF', err, { diId: _id });
        }

        return updatedDi;
      }
    } catch (error) {
      await this.captureUploadFailure('ADD_BL_PDF', error, _id);
      throw error;
    }
  }

  async addFacturePDF(_id: string, pdf: string) {
    try {
      const di = await this.diModel.findOne({ _id });
      if (!di) throw new Error(`DI '${_id}' not found`);

      const { webViewLink, driveFileId, fileName } =
        await this.uploadDiDocToDrive(di, pdf, 'Facture');

      if (di.ignoreCount && di.ignoreCount > 0) {
        await this.logsDiService.addFacturePDFLogs(
          di._id,
          di.ignoreCount,
          webViewLink,
        );
      } else {
        await this.diModel.updateOne(
          { _id },
          {
            $set: {
              facture: webViewLink,
              'driveDocs.Facture': { driveFileId, webViewLink, name: fileName },
            },
          },
        );
      }
      // Return the fresh DI (mutation is typed `() => Di`).
      return await this.diModel.findOne({ _id });
    } catch (error) {
      await this.captureUploadFailure('ADD_FACTURE_PDF', error, _id);
      throw error;
    }
  }

  async addBCPDF(_id: string, pdf: string) {
    try {
      const di = await this.diModel.findOne({ _id });
      if (!di) throw new Error(`DI '${_id}' not found`);

      const { webViewLink, driveFileId, fileName } =
        await this.uploadDiDocToDrive(di, pdf, 'BC');

      let result;

      if (di.ignoreCount && di.ignoreCount > 0) {
        result = await this.logsDiService.addBCPDFLogs(
          di._id,
          di.ignoreCount,
          webViewLink,
        );
      } else {
        result = await this.diModel.updateOne(
          { _id },
          {
            $set: {
              bon_de_commande: webViewLink,
              'driveDocs.BC': { driveFileId, webViewLink, name: fileName },
            },
          },
        );
      }

      // 🔔 Discord notification (BC uploaded)
      try {
        await this.discordHookService.sendDiBCUploaded({
          di,
          fileName,
        });
      } catch (err) {
        await this.captureDiscordFailure('addBCPDF', err, { diId: _id });
      }

      // Return the fresh DI (the mutation is typed `() => Di`); `result` is a
      // Mongo update/log result with no Di fields.
      return await this.diModel.findOne({ _id });
    } catch (error) {
      await this.captureUploadFailure('ADD_BC_PDF', error, _id);
      throw error;
    }
  }

  // async getDiById(_id:string){
  //   return await
  // }

  async updateDi(updateDi: UpdateDi) {
    const { _id, ...rest } = updateDi;

    // Defensive: drop undefined values so a partial-update payload that
    // supplies only { _id, location_id } does not blank out other fields.
    // Mongoose generally ignores undefined keys but being explicit keeps
    // the behavior predictable across driver versions.
    const updateSet: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) {
        updateSet[key] = value;
      }
    }

    const previous = await this.diModel.findOne({ _id }).select('location_id');
    const update = await this.diModel.findOneAndUpdate(
      { _id },
      { $set: updateSet },
      { new: true },
    );

    if (
      update &&
      previous?.location_id &&
      String(previous.location_id) !== String(update.location_id)
    ) {
      await this.syncEmplacementStatsForChange(
        previous.location_id as any,
        update.location_id as any,
      );
    }

    if (update) {
      // Broadcast the same updateTicket signal that every status mutation
      // emits, so all subscribed lists/dashboards refresh and pick up the
      // new location_id / di_category_id / etc. without manual reload.
      this.notificationGateway.updateTicket({
        action: 'updateState',
        content: { result: update, states: update },
        target: {},
      });
    }

    return update;
  }

  private async syncEmplacementStats(emplacementId?: string): Promise<void> {
    if (!emplacementId) {
      return;
    }

    const storedDiCount = await this.diModel.countDocuments({
      location_id: emplacementId,
      isDeleted: false,
    });

    await this.locationModel.updateOne(
      { _id: emplacementId },
      {
        $set: {
          storedDiCount: Math.max(0, storedDiCount),
          hasStoredDi: storedDiCount > 0,
          current_item_stored: Math.max(0, storedDiCount),
        },
      },
    );
  }

  private async syncEmplacementStatsForChange(
    oldEmplacementId?: string,
    newEmplacementId?: string,
  ): Promise<void> {
    const ids = Array.from(
      new Set([oldEmplacementId, newEmplacementId].filter(Boolean)),
    );

    await Promise.all(ids.map((id) => this.syncEmplacementStats(id)));
  }

  async addPDFFile(_id: string, facture: string, bl: string) {
    const di = await this.diModel.findOne({ _id });
    if (!di) throw new Error(`DI '${_id}' not found`);

    // Drive-only: both files renamed + uploaded to the DI's entity folder.
    const factureRef = await this.uploadDiDocToDrive(di, facture, 'Facture');
    const blRef = await this.uploadDiDocToDrive(di, bl, 'BL');

    return await this.diModel.updateOne(
      { _id },
      {
        $set: {
          facture: factureRef.webViewLink,
          bon_de_livraison: blRef.webViewLink,
          'driveDocs.Facture': {
            driveFileId: factureRef.driveFileId,
            webViewLink: factureRef.webViewLink,
            name: factureRef.fileName,
          },
          'driveDocs.BL': {
            driveFileId: blRef.driveFileId,
            webViewLink: blRef.webViewLink,
            name: blRef.fileName,
          },
        },
      },
    );
  }
  async searchDi(
    paginationConfig: PaginationConfigDi,
    search: { field: string; value: string },
  ) {
    const { first, rows } = paginationConfig;
    const { field, value } = search;

    // Base filter
    const filter: any = { isDeleted: false };

    // Only apply search if value has 2+ characters
    if (field && value && value.trim().length >= 2) {
      const trimmedValue = value.trim();
      let regex: any;

      regex = { $regex: `${trimmedValue}`, $options: 'i' };

      switch (field) {
        case '_id':
        case '_idnum':
        case 'title':
          filter[field] = regex;
          break;

        case 'status':
          filter.$and = [...(filter.$and ?? []), { status: regex }];
          break;

        case 'company':
          const companyIds = await this.companyModel
            .find({ name: regex })
            .distinct('_id');
          if (companyIds.length > 0) filter.company_id = { $in: companyIds };
          break;

        case 'client':
          const clientIds = await this.clientModel
            .find({ $or: [{ first_name: regex }, { last_name: regex }] })
            .distinct('_id');
          if (clientIds.length > 0) filter.client_id = { $in: clientIds };
          break;

        case 'location':
          const locationIds = await this.locationModel
            .find({ location_name: regex })
            .distinct('_id');
          if (locationIds.length > 0) filter.location_id = { $in: locationIds };
          break;
        case 'techDiag': {
          // 1. Find matching profiles
          const profileIds = await this.profileModel
            .find({ $or: [{ firstName: regex }, { lastName: regex }] })
            .distinct('_id');

          if (profileIds.length === 0) break;

          // 2. Find stats where tech diag matches
          const diIds = await this.statModel
            .find({ id_tech_diag: { $in: profileIds } })
            .distinct('_idDi');

          if (diIds.length > 0) {
            filter._id = { $in: diIds };
          }
          break;
        }

        case 'techRep': {
          // 1. Find matching profiles
          const profileIds = await this.profileModel
            .find({ $or: [{ firstName: regex }, { lastName: regex }] })
            .distinct('_id');

          if (profileIds.length === 0) break;

          // 2. Find stats where tech rep matches
          const diIds = await this.statModel
            .find({ id_tech_rep: { $in: profileIds } })
            .distinct('_idDi');

          if (diIds.length > 0) {
            filter._id = { $in: diIds };
          }
          break;
        }

        case 'createdBy':
          const profileIds = await this.profileModel
            .find({ $or: [{ firstName: regex }, { lastName: regex }] })
            .distinct('_id');
          if (profileIds.length > 0) filter.createdBy = { $in: profileIds };
          break;
      }
    }

    // COUNT
    const totalDiCount = await this.diModel.countDocuments(filter);

    // FETCH
    const diRecords = await this.diModel
      .find(filter)
      .populate('client_id', 'first_name last_name')
      .populate('company_id', 'name')
      .populate('createdBy', 'firstName lastName')
      .populate('location_id', '_id location_name')
      .populate('di_category_id', '_id category')
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();

    // MAP RESPONSE
    const di = await Promise.all(
      diRecords.map(async (di) => {
        const stat = await this.statModel.findOne({ _idDi: di._id });
        const logsDi = await this.logsDiService.getAllLogsByDi(di._id);

        return {
          _id: di._id,
          _idnum: di._idnum,
          title: di.title,
          description: di.description,
          remarque_tech_diagnostic: di.remarque_tech_diagnostic,
          remarque_manager: di.remarque_manager,
          remarque_tech_repair: di.remarque_tech_repair,
          ignoreCount: di.ignoreCount,
          can_be_repaired: di.can_be_repaired,
          bon_de_commande: di.bon_de_commande,
          bon_de_livraison: di.bon_de_livraison,
          facture: di.facture,
          devis: di.devis,
          contain_pdr: di.contain_pdr,
          current_roles: di.current_roles,
          array_composants: di.array_composants,
          isErrorFromFixtronix: di.isErrorFromFixtronix,
          // Keep `*_id` as the actual referenced _id so the frontend can
          // run lookups, drive dropdown ngModel values, and patch state
          // immutably after a reassignment. The display strings live on
          // dedicated `*_name` fields.
          di_category_id: (di.di_category_id as any)?._id ?? null,
          di_category_name: (di.di_category_id as any)?.category ?? 'N/A',
          location_id: (di.location_id as any)?._id ?? null,
          location_name: (di.location_id as any)?.location_name ?? 'N/A',
          status: di.status,
          pricingRequestSentAt: di.pricingRequestSentAt,
          pricingRequestSentBy: di.pricingRequestSentBy,
          componentsConfirmedAt: di.componentsConfirmedAt,
          componentsConfirmedBy: di.componentsConfirmedBy,
          price: di.price ?? null,
          final_price: di.final_price ?? null,
          createdAt: moment(di.createdAt).format('YYYY-MM-DD:HH-mm-ss'),
          image: di?.image?.length > 0 ? di.image : '-',
          client_id: di.client_id?.first_name ?? '-',
          company_id: di.company_id?.name ?? '-',
          createdBy: `${di.createdBy?.firstName ?? '-'} ${
            di.createdBy?.lastName ?? ''
          }`,
          techDiag: stat?.id_tech_diag
            ? await this.profileService.getTech(stat.id_tech_diag)
            : 'N/A',
          techRep: stat?.id_tech_rep
            ? await this.profileService.getTech(stat.id_tech_rep)
            : 'N/A',
          logs: logsDi.length > 0 ? logsDi : [],
        };
      }),
    );

    return { di, totalDiCount };
  }

  // workage
  async getAllDi(
    paginationConfig: PaginationConfigDi,
    filterConfig?: FilterConfigDi,
  ) {
    const { first, rows } = paginationConfig;
    const { startDate, endDate } = filterConfig || {};

    const filter: any = { isDeleted: false };

    if (startDate && startDate !== 'null') {
      filter.createdAt = { $gte: new Date(startDate) };
    }

    if (endDate && endDate !== 'null') {
      filter.createdAt = {
        ...filter.createdAt,
        $lte: new Date(endDate),
      };
    }

    const totalDiCount = await this.diModel.countDocuments(filter).exec();

    const diRecords = await this.diModel
      .find(filter)
      .populate('client_id', 'first_name last_name')
      .populate('company_id', 'name')
      .populate('createdBy', 'firstName lastName')
      .populate('location_id', '_id location_name')
      .populate('di_category_id', '_id category')
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();

    // Fetch linked stats & logs for each DI
    const di = await Promise.all(
      diRecords.map(async (di) => {
        // Fetch the stat document based on the DI's _id
        const stat = await this.statModel.findOne({ _idDi: di._id }).exec();

        // Fetch logs related to this DI
        const logsDi = await this.logsDiService.getAllLogsByDi(di._id);

        return {
          _id: di._id,
          _idnum: di._idnum,
          remarque_tech_diagnostic: di.remarque_tech_diagnostic,
          remarque_manager: di.remarque_manager,
          remarque_tech_repair: di.remarque_tech_repair,
          title: di.title,
          description: di.description,
          ignoreCount: di.ignoreCount,
          can_be_repaired: di.can_be_repaired,
          bon_de_commande: di.bon_de_commande,
          bon_de_livraison: di.bon_de_livraison,
          facture: di.facture,
          devis: di.devis,
          contain_pdr: di.contain_pdr,
          current_roles: di.current_roles,
          array_composants: di.array_composants,
          isErrorFromFixtronix: di.isErrorFromFixtronix,
          // See the symmetric note in searchDi above — `*_id` carries
          // the referenced _id, `*_name` carries the display string.
          di_category_id: (di.di_category_id as any)?._id ?? null,
          di_category_name: (di.di_category_id as any)?.category ?? 'N/A',
          location_id: (di.location_id as any)?._id ?? null,
          location_name: (di.location_id as any)?.location_name ?? 'N/A',
          status: di.status,
          pricingRequestSentAt: di.pricingRequestSentAt,
          pricingRequestSentBy: di.pricingRequestSentBy,
          componentsConfirmedAt: di.componentsConfirmedAt,
          componentsConfirmedBy: di.componentsConfirmedBy,
          price: di.price ?? null,
          final_price: di.final_price ?? null,
          createdAt: moment(di.createdAt).format('YYYY-MM-DD:HH-mm-ss'),
          image: di?.image?.length > 0 ? di.image : '-',
          client_id: di.client_id?.first_name ?? '-',
          company_id: di.company_id?.name ?? '-',
          createdBy: `${di.createdBy?.firstName ?? '-'} ${
            di.createdBy?.lastName ?? ''
          }`,
          // Include some fields from the linked stat if available
          techDiag: stat?.id_tech_diag
            ? await this.profileService.getTech(stat?.id_tech_diag)
            : 'N/A',
          techRep: stat?.id_tech_rep
            ? await this.profileService.getTech(stat?.id_tech_rep)
            : 'N/A',
          // Include logs related to this DI
          logs: logsDi.length > 0 ? logsDi : [],
        };
      }),
    );
    return { di, totalDiCount };
  }

  async confirmationBetweenMagasinAndCoordinator(
    _id: string,
    confirmationComposant: string,
    _idNotification?: string,
  ) {
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      { $set: { confirmationComposant } },
      { new: true },
    );

    if (!result) {
      throw new Error('Error while confirmation composant');
    }

    if (confirmationComposant === 'CONFIRM') {
      let auditInput: AuditInput = {
        _idDoc: _id,
        message: confirmationComposant,
        type: 'CONFIRMATION_COMPOSANT',
        isSeen: false,
      };
      await this.auditService.create(auditInput);
      this.notificationGateway.confirmComposant(auditInput);
    }
    if (confirmationComposant === 'REPLY') {
      let reply: any = {
        _idDoc: _id,
        message: confirmationComposant,
        type: 'CONFIRMATION_COMPOSANT',
        isSeen: true,
      };
      await this.auditService.updateConfirm(
        _idNotification,
        confirmationComposant,
      );
      this.notificationGateway.confirmComposant(reply); //
    }

    return result;
  }

  async calculateTicketComposantPrice(ticketId: string) {
    let totlalComposant;
    const ticket = await this.diModel.findById(ticketId);
    if (!ticket) {
      throw new Error('Ticket not found');
    }

    if (ticket.ignoreCount && ticket.ignoreCount > 0) {
      return await this.logsDiService.calculateComposantTicketPrice(
        ticket._id,
        ticket.ignoreCount,
      );
    } else {
      const totalPrice = await Promise.all(
        ticket.array_composants.map(async (item) => {
          const composant = await this.composantModel.findOne({
            name: item.nameComposant,
          });

          return composant ? composant.prix_vente * item.quantity : 0;
        }),
      );
      // TODO substruct the quantity needed from compsant in stock.
      return totalPrice.reduce((acc, curr) => acc + curr, 0);
    }
  }

  /**
   * M1 guard — load the DI, fail with a clean NOT_FOUND if it's missing, then
   * reject an illegal status transition (BAD_REQUEST) BEFORE any write. Call at
   * the very top of every status-transition method so an out-of-sequence jump
   * (e.g. CREATED → FINISHED) can never mutate the DI.
   */
  private async assertTransitionAllowed(
    _id: string,
    targetStatus: string,
  ): Promise<void> {
    const di = await this.diModel.findOne({ _id }).select('status').lean();
    if (!di) {
      throw new GraphQLError(`DI '${_id}' introuvable.`, {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    assertDiTransition((di as any).status, targetStatus);
  }

  // from Created ==> PENDING1
  // from Manager => coordinator
  async manager_Pending1(_idDI: string): Promise<Di> {
    await this.assertTransitionAllowed(_idDI, STATUS_DI.Pending1.status);
    const result = await this.diWorkflowService.transition({
      diId: _idDI,
      transitionKey: 'MANAGER_TO_PENDING1',
      skipFromValidation: true,
      skipRoleValidation: true,
    });

    return result.di;
  }

  // InMagasin or InDiagnostic ==> PENDING2
  //from magasin or tech to coordinator
  async magasinTech_Pending2(_idDI: string): Promise<Di> {
    await this.assertTransitionAllowed(_idDI, STATUS_DI.Pending2.status);
    const result = await this.diWorkflowService.transition({
      diId: _idDI,
      transitionKey: 'MAGASIN_TECH_TO_PENDING2',
      skipFromValidation: true,
      skipRoleValidation: true,
    });

    // This is the real "Diagnostic Completed" event: the DI leaves the
    // diagnostic phase for pricing. Diag form fields persisted earlier
    // by tech_startDiagnostic are read off the DI document.
    try {
      await this.discordHookService.sendDiagnosticFinished({
        di: result.di,
        diag: {
          can_be_repaired: (result.di as any)?.can_be_repaired,
          contain_pdr: (result.di as any)?.contain_pdr,
          isErrorFromFixtronix: (result.di as any)?.isErrorFromFixtronix,
          remarque_tech_diagnostic: (result.di as any)
            ?.remarque_tech_diagnostic,
        },
      });
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    return result.di;
  }
  //TODO check if we need to delet this one
  // Negotiation1 or Negotiation2 ==> PENDING3
  // Admin or manager ==> coordinator
  async managerAdminManager_Pending3(_idDI: string): Promise<Di> {
    await this.assertTransitionAllowed(_idDI, STATUS_DI.Pending3.status);
    const result = await this.diWorkflowService.transition({
      diId: _idDI,
      transitionKey: 'MANAGER_ADMIN_TO_PENDING3',
      skipFromValidation: true,
      skipRoleValidation: true,
    });

    return result.di;
  }
  //New flow Nego1 & Nego2 sending DI to the INMagasin

  async managerAdminManager_InMagasin(
    _idDi: string,
    price: number,
    final_price: number,
  ): Promise<UpdateNego> {
    const pricingNeg = await this.diModel.findOne({ _id: _idDi });

    if (pricingNeg && pricingNeg.ignoreCount && pricingNeg.ignoreCount > 0) {
      return this.logsDiService.savePricing(
        _idDi,
        pricingNeg.ignoreCount,
        price,
        final_price,
      );
    } else {
      // `{ new: true }` returns the POST-update document. Without it Mongoose
      // returns the pre-update doc, where `final_price` is still the previous
      // value (null on first save) — GraphQL then rejects the response because
      // `UpdateNego.final_price` is non-nullable, the cascade aborts on step 1,
      // and the DI never advances. Surfaced by the P4 happy-path UI e2e.
      return await this.diModel.findOneAndUpdate(
        { _id: _idDi },
        {
          $set: {
            price,
            final_price,
          },
        },
        { new: true },
      );
    }
  }

  //coordinator sending to tech for  diagnostic
  async coordinator_ToDiag(_idDI: string) {
    await this.assertTransitionAllowed(_idDI, STATUS_DI.Diagnostic.status);
    const diagnostic = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: STATUS_DI.Diagnostic.role,
          status: STATUS_DI.Diagnostic.status,
          isOpenedOnce: true,
        },
      },
      { new: true },
    );

    if (!diagnostic) {
      throw new Error('error in changing status to diagnostic ');
    }

    if (diagnostic.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _idDI,
        STATUS_DI.Diagnostic.status,
        diagnostic.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_idDI, STATUS_DI.Diagnostic.status);
    }

    try {
      await this.discordHookService.sendDiagnosticAssigned(diagnostic);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    return diagnostic;
  }
  //coordinator sending to tech for list of di to reperation
  async coordinator_ToRep(_idDI: string, tech_id: string) {
    const reparation = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_workers_ids: tech_id,
          current_roles: Role.TECH,
          status: STATUS_DI.Reparation,
        },
      },
    );

    if (!reparation) {
      throw new Error('Issue in changing status to rep');
    }

    if (reparation.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _idDI,
        STATUS_DI.Reparation.status,
        reparation.ignoreCount,
      );
    }

    await this.statsService.updateStatus(_idDI, STATUS_DI.Reparation.status);
    return reparation;
  }

  async setDiInPause(_id: string) {
    return await this.diModel.findByIdAndUpdate(
      { _id },
      {
        $set: {
          is_paused: true,
        },
      },
      { new: true },
    );
  }

  //Tech finsih diagnostic
  async tech_startDiagnostic(_idDI: string, diag: DiagUpdate) {
    const didata = await this.diModel.findOne({ _id: _idDI });

    let updatedDi;

    if (didata && didata.ignoreCount && didata.ignoreCount > 0) {
      updatedDi = await this.logsDiService.tech_startDiagnostic(
        didata._id,
        didata.ignoreCount,
        diag,
      );
    } else {
      updatedDi = await this.diModel.findOneAndUpdate(
        { _id: _idDI },
        {
          $set: {
            can_be_repaired: diag.can_be_repaired,
            contain_pdr: diag.contain_pdr,
            remarque_tech_diagnostic: diag.remarque_tech_diagnostic,
            array_composants: diag.array_composants,
            di_category_id: diag.di_category_id,
            isErrorFromFixtronix: diag.isErrorFromFixtronix ?? false,
          },
        },
        { new: true },
      );
    }

    // Note: this method only persists the diagnostic form values; it is
    // also invoked by the pause flow on the frontend, so firing
    // "Diagnostic Completed" here produced wrong notifications during
    // pause. The real diagnostic-completed event is the transition to
    // PENDING2 via magasinTech_Pending2 — that's where the embed lives.

    return updatedDi;
  }

  async getStatusCount() {
    // Get all statuses from the STATUS_DI object
    const allStatuses = Object.values(STATUS_DI).map((status) => status.status);

    // Perform aggregation
    const results = await this.diModel.aggregate([
      {
        $match: {
          isDeleted: false,
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          status: '$_id',
          count: 1,
        },
      },
    ]);

    // Map results to a dictionary for easier lookup
    const resultMap = new Map(results.map((r) => [r.status, r.count]));

    // Build the final result, ensuring all statuses are included
    const finalResults = allStatuses.map((status) => ({
      status,
      count: resultMap.get(status) || 0,
    }));

    return finalResults;
  }

  async markAsSeen(_id: string) {
    return await this.diModel.findByIdAndUpdate(
      { _id },
      {
        $set: {
          isOpenedOnce: true,
        },
      },
      { new: true },
    );
  }

  //Tech closing diagnostic
  async tech_stopDiagnostic(_idDI: string) {
    const result = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.TECH,
          status: STATUS_DI.Diagnostic.status,
        },
      },
      { new: true },
    );
    if (!result) {
      throw new Error('Issue in changing state tech_stopDiagnostic');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _idDI,
        STATUS_DI.Diagnostic.status,
        result.ignoreCount,
      );
    }
    await this.statsService.updateStatus(_idDI, STATUS_DI.Diagnostic.status);
    return result;
  }
  //Tech finsih diagnostic
  async tech_finishDiagnostic(_idDI: string, contain_pdr: boolean) {
    const result = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.TECH,
          status: {
            $cond: {
              contain_pdr,
              then: STATUS_DI.InMagasin.status,
              else: STATUS_DI.Pending2.status,
            },
          },
        },
      },
    );
    if (!result) {
      throw new Error('Issue in changing state tech_finishDiagnostic');
    }
    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _idDI,
        STATUS_DI.Diagnostic.status,
        result.ignoreCount,
      );
    }
    await this.statsService.updateStatus(_idDI, STATUS_DI.Diagnostic.status);
    return result;
  }
  //Tech starting Reperation
  async tech_startReperation(_idDI: string) {
    const result = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.TECH,
          status: STATUS_DI.InReparation.status,
        },
      },
    );
    if (!result) {
      throw new Error('Issue in changing state tech_startReperation');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _idDI,
        STATUS_DI.InReparation.status,
        result.ignoreCount,
      );
    }
    await this.statsService.updateStatus(_idDI, STATUS_DI.InReparation.status);
    return result;
  }

  //Tech closing reperation
  async tech_stopReperation(_idDI: string) {
    const result = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.TECH,
          status: STATUS_DI.Reparation.status,
        },
      },
      { new: true },
    );
    if (!result) {
      throw new Error('Issue in changing state tech_stopReperation');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _idDI,
        STATUS_DI.Reparation.status,
        result.ignoreCount,
      );
    }
    await this.statsService.updateStatus(_idDI, STATUS_DI.Reparation.status);
    return result;
  }
  //Tech finsih Reperation
  async tech_finishReperation(_idDI: string, remarque: string) {
    let updateReamrqueRep;
    const di = await this.diModel.findOne({ _id: _idDI });

    if (di && di.ignoreCount && di.ignoreCount > 0) {
      updateReamrqueRep = await this.logsDiService.tech_finishReperationLogs(
        _idDI,
        di.ignoreCount,
        remarque,
      );
    } else {
      updateReamrqueRep = await this.diModel.findOneAndUpdate(
        { _id: _idDI },
        {
          $set: {
            remarque_tech_repair: remarque,
          },
        },
        { new: true },
      );
    }

    return updateReamrqueRep;
  }

  async changeStatusTofinsh(_id: string) {
    await this.assertTransitionAllowed(_id, STATUS_DI.Finished.status);
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      { $set: { status: STATUS_DI.Finished.status } },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in changing state changeStatusTofinsh');
    }

    // ✅ Fix: call statsService only once
    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.Finished.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.Finished.status);
    }

    // 🔔 Discord notification (Finished)
    try {
      await this.discordHookService.sendDiFinished(result);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    return result;
  }
  //Coordiantor sending to the Admins for affecting price
  // PENDING2 => Pricing
  async coordinator_ToPricing(_idDI: string) {
    const result = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: [Role.ADMIN_MANAGER, Role.ADMIN_TECH],
          status: STATUS_DI.Pricing.status,
        },
      },
    );

    if (!result) {
      throw new Error('Issue in changing state coordinator_ToPricing');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _idDI,
        STATUS_DI.Pricing.status,
        result.ignoreCount,
      );
    }
  }

  //from admins to manager to give the first price
  // Pricing => Negotiation1
  async admins_Pricing(_idDI: string, price: number) {
    const result = await this.diModel.updateOne(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.MANAGER,
          status: STATUS_DI.Negotiation1.status,
          price: price,
        },
      },
    );

    if (!result) {
      throw new Error('Issue in admins_Pricing ');
    }

    return result;
  }

  //from manager or AdminsManager to annuler DI
  // Negotiation1 or Negotiation2 => Annuler
  async annulerDi(_idDI: string) {
    const updated = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: [Role.ADMIN_MANAGER, Role.ADMIN_TECH, Role.MANAGER],
          status: STATUS_DI.Annuler.status,
        },
      },
      { new: true },
    );

    if (!updated) {
      throw new Error('Issue in annulerDi ');
    }

    try {
      await this.discordHookService.sendDiCancelled(updated);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    return updated;
  }
  //if DI confirmer we sent to coordiantor
  // Negotiation1  => Pending3
  async manager_Negotation_Pendin3(
    _idDI: string,
    discount_value: number,
    final_price: number,
  ) {
    const result = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.COORDINATOR,
          discount_value: discount_value,
          final_price: final_price,
          status: STATUS_DI.Pending3.status,
        },
      },
    );

    if (!result) {
      throw new Error('Issue in manager_Negotation_Pendin3 ');
    }
  }
  //if DI NOT confirmer we sent to Admin Manager
  // Negotiation1  => Negotiation2
  async manager_Negotation1_Negotation2(_idDI: string) {
    const result = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.ADMIN_MANAGER,
          status: STATUS_DI.Negotiation2.status,
        },
      },
    );

    if (!result) {
      throw new Error('Issue in manager_Negotation1_Negotation2 ');
    }

    return result;
  }
  //Retour DI from finished to RETOUR 1
  //send by manager to coordinator so he can chose who gonna repair it
  async di_Retour1(_idDI: string) {
    const result = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.COORDINATOR,
          status: STATUS_DI.Retour1.status,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in di_Retour1');
    }

    return result;
  }
  async di_Retour2(_idDI: string) {
    const result = await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.COORDINATOR,
          status: STATUS_DI.Retour2.status,
        },
      },
      { new: true },
    );
    if (!result) {
      throw new Error('Issue di_Retour2');
    }

    return result;
  }
  async di_Retour3(_idDI: string) {
    const result = await this.diModel.updateOne(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.COORDINATOR,
          status: STATUS_DI.Retour3.status,
        },
      },
    );
    if (!result) {
      throw new Error('Issue in di_Retour3 ');
    }

    return result;
  }
  async searchCoordinatorDI(
    paginationConfig: PaginationConfigDi,
    search: { field: string; value: string },
  ) {
    const { first, rows } = paginationConfig;
    const { field, value } = search;

    // ✅ Coordinator base filter — full visibility (no status restriction).
    //    Action-gating still happens per-mutation; this only widens the read.
    const filter: any = {
      isDeleted: false,
    };

    // ✅ Apply search only if valid
    if (field && value && value.trim().length >= 2) {
      const regex = { $regex: value.trim(), $options: 'i' };

      switch (field) {
        case '_id':
        case '_idnum':
        case 'title':
          filter[field] = regex;
          break;

        case 'status':
          filter.$and = [...(filter.$and ?? []), { status: regex }];
          break;

        case 'company': {
          const ids = await this.companyModel
            .find({ name: regex })
            .distinct('_id');
          if (ids.length) filter.company_id = { $in: ids };
          break;
        }

        case 'client': {
          const ids = await this.clientModel
            .find({ $or: [{ first_name: regex }, { last_name: regex }] })
            .distinct('_id');
          if (ids.length) filter.client_id = { $in: ids };
          break;
        }

        case 'location': {
          const ids = await this.locationModel
            .find({ location_name: regex })
            .distinct('_id');
          if (ids.length) filter.location_id = { $in: ids };
          break;
        }

        case 'createdBy': {
          const ids = await this.profileModel
            .find({ $or: [{ firstName: regex }, { lastName: regex }] })
            .distinct('_id');
          if (ids.length) filter.createdBy = { $in: ids };
          break;
        }

        case 'techDiag':
        case 'techRep': {
          const profileIds = await this.profileModel
            .find({ $or: [{ firstName: regex }, { lastName: regex }] })
            .distinct('_id');

          if (!profileIds.length) break;

          const statField =
            field === 'techDiag' ? 'id_tech_diag' : 'id_tech_rep';

          const diIds = await this.statModel
            .find({ [statField]: { $in: profileIds } })
            .distinct('_idDi');

          if (diIds.length) filter._id = { $in: diIds };
          break;
        }
      }
    }

    // 🔢 Count
    const totalDiCount = await this.diModel.countDocuments(filter);

    // 📦 Fetch
    const diRecords = await this.diModel
      .find(filter)
      .populate('client_id', 'first_name last_name')
      .populate('company_id', 'name')
      .populate('createdBy', 'firstName lastName')
      .populate('location_id', 'location_name')
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();

    // 🔁 Map
    const di = await Promise.all(
      diRecords.map(async (di) => {
        const stat = await this.statModel.findOne({ _idDi: di._id });
        const logs = await this.logsDiService.getAllLogsByDi(di._id);

        return {
          _id: di._id,
          _idnum: di._idnum,
          title: di.title,
          status: di.status,
          pricingRequestSentAt: di.pricingRequestSentAt,
          pricingRequestSentBy: di.pricingRequestSentBy,
          componentsConfirmedAt: di.componentsConfirmedAt,
          componentsConfirmedBy: di.componentsConfirmedBy,
          price: di.price ?? null,
          final_price: di.final_price ?? null,
          createdAt: moment(di.createdAt).format('YYYY-MM-DD:HH-mm-ss'),
          location_id: di.location_id?.location_name ?? 'N/A',
          company_id: di.company_id?.name ?? '-',
          client_id: di.client_id?.first_name ?? '-',
          createdBy: `${di.createdBy?.firstName ?? '-'} ${
            di.createdBy?.lastName ?? ''
          }`,
          techDiag: stat?.id_tech_diag
            ? await this.profileService.getTech(stat.id_tech_diag)
            : 'N/A',
          techRep: stat?.id_tech_rep
            ? await this.profileService.getTech(stat.id_tech_rep)
            : 'N/A',
          logs,
        };
      }),
    );

    return { di, totalDiCount };
  }

  // *Query For Coordinator
  async get_coordinatorDI(paginationConfig: PaginationConfigDi) {
    // Coordinator now sees the full DI list (no status filter). Soft-deleted
    // rows still excluded so the previous safety stays. Per-status actions
    // remain gated in the FE / mutations — visibility ≠ ability to act.
    const queryCoordinator = {
      isDeleted: false,
    };
    const { first, rows } = paginationConfig;
    const totalDiCount = await this.diModel.countDocuments(queryCoordinator);
    const di = await this.diModel
      .find(queryCoordinator)
      .populate('client_id', 'first_name last_name')
      .populate('createdBy', 'firstName lastName')
      .populate('location_id', '_id location_name')
      .populate('company_id', 'name ')
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first);

    const coordDiList = await Promise.all(di.map(async (di) => {
      // Fetch the stat document based on the DI's _id
      const stat = await this.statModel.findOne({ _idDi: di._id }).exec();
      // Fetch logs related to this DI
      const logsDi = await this.logsDiService.getAllLogsByDi(di._id);
      return {
        //nezih
        _id: di._id,
        _idnum: di._idnum,
        title: di.title,
        final_price: di.final_price,
        price: di.price,
        description: di.description,
        ignoreCount: di.ignoreCount,
        can_be_repaired: di.can_be_repaired,
        bon_de_commande: di.bon_de_commande,
        bon_de_livraison: di.bon_de_livraison,
        contain_pdr: di.contain_pdr,
        current_roles: di.current_roles,
        array_composants: di.array_composants,
        di_category_id: di.di_category_id?.category,
        remarque_admin_manager: null,
        remarque_admin_tech: di.remarque_admin_tech,
        remarque_coordinator: di.remarque_coordinator,
        remarque_magasin: di.remarque_magasin,
        remarque_manager: di.remarque_manager,
        techDiag: stat?.id_tech_diag
          ? await this.profileService.getTech(stat?.id_tech_diag)
          : 'N/A',
        techRep: stat?.id_tech_rep
          ? await this.profileService.getTech(stat?.id_tech_rep)
          : 'N/A',
        remarque_tech_diagnostic: di.remarque_tech_diagnostic,
        remarque_tech_repair: di.remarque_tech_repair,
        createdAt: moment(di.createdAt).format('YYYY-MM-DD:HH-mm-ss'),
        updatedAt: di.updatedAt,
        location_id: di.location_id?.location_name ?? 'N/A',
        status: di.status,
        retourReason: di.retourReason,
        retourDate: di.retourDate,
        pricingRequestSentAt: di.pricingRequestSentAt,
        pricingRequestSentBy: di.pricingRequestSentBy,
        componentsConfirmedAt: di.componentsConfirmedAt,
        componentsConfirmedBy: di.componentsConfirmedBy,
        image: di.image,
        handleSendingNotificationBetweenCoordinatorAndMagasin:
          di.handleSendingNotificationBetweenCoordinatorAndMagasin,
        logs: logsDi,
        isSentToCoordinator: di.isSentToCoordinator,
        isConfirmedComponentFromCoordinator:
          di.isConfirmedComponentFromCoordinator,
        company_id: di.company_id?.name ?? '-', // Provide default values if necessary
        client_id: di.client_id?.first_name ?? '-', // Provide default values if necessary
        createdBy: `${di.createdBy?.firstName ?? 'Unknown'} ${
          di.createdBy?.lastName ?? ''
        }`,
      };
    }));

    return { di: coordDiList, totalDiCount };
  }
  // Query For Tech
  async getAll_TechDI(tech_id: string) {
    try {
      return await this.diModel.find({
        current_workers_ids: tech_id,
        status: { $in: TECH_STATUS_DI_VALUES },
        isDeleted: { $ne: true },
      });
    } catch (err) {
      await this.operationalErrorService.capture({
        module: 'di',
        submodule: 'diService',
        method: 'GET_ALL_TECH_DI',
        severity: 'HIGH',
        error: 'Failed to load tech DI list',
        message: (err as Error)?.message ?? String(err),
        payload: { tech_id },
      });
      // Safe default — return empty list rather than the Error object,
      // which previously got rendered as a row by the frontend.
      return [];
    }
  }
  //! working here
  async getDiForMagasin(paginationConfig: PaginationConfigDi) {
    const queryMagasin = {
      contain_pdr: true,
      status: { $in: MAGASIN_STATUS_DI_VALUES },
      isDeleted: false,
    };

    const { first, rows } = paginationConfig;
    const totalDiCount = await this.diModel.countDocuments(queryMagasin);
    const di = await this.diModel
      .find(queryMagasin)
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first);

    return { di, totalDiCount };
  }

  async searchDiForMagasin(
    paginationConfig: PaginationConfigDi,
    search: { field: string; value: string },
  ) {
    const { first, rows } = paginationConfig;
    const { field, value } = search;

    // ✅ Base filter
    const filter: any = {
      contain_pdr: true,
      status: { $in: MAGASIN_STATUS_DI_VALUES },
      isDeleted: false,
    };

    // ✅ Search ONLY title & status
    if (
      value &&
      value.trim().length >= 2 &&
      ['title', 'status'].includes(field)
    ) {
      const regex = {
        $regex: value.trim(),
        $options: 'i',
      };

      if (field === 'status') {
        filter.$and = [...(filter.$and ?? []), { status: regex }];
      } else {
        filter[field] = regex;
      }
    }

    // 🔢 Count
    const totalDiCount = await this.diModel.countDocuments(filter);

    // 📦 Fetch
    const diRecords = await this.diModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();
    return { di: diRecords, totalDiCount };
  }

  async setSelectedComponentAsDone(
    _id: string,
    nameComponent: string,
  ): Promise<any> {
    const di = await this.diModel.findOne({ _id });

    if (di && di.ignoreCount && di.ignoreCount > 0) {
      return await this.logsDiService.setSelectedComponentAsDoneLogs(
        di._id,
        di.ignoreCount,
        nameComponent,
      );
    } else {
      // Find the document with the specific component
      const updatedDocument = await this.diModel.findOneAndUpdate(
        { _id, 'array_composants.nameComposant': nameComponent },
        { $set: { 'array_composants.$.isUpdated': true } }, // Update only the matched component
        { new: true }, // Return the updated document
      );

      if (!updatedDocument) {
        throw new NotFoundException(`Document or component not found.`);
      }

      return updatedDocument;
    }
  }

  async affectinitialPrice(_id: string, price: number) {
    const pricing = await this.diModel.findOne({ _id });

    let updatedDi;

    if (pricing && pricing.ignoreCount && pricing.ignoreCount > 0) {
      updatedDi = await this.logsDiService.savePricing(
        pricing._id,
        pricing.ignoreCount,
        price,
      );
    } else {
      updatedDi = await this.diModel.findOneAndUpdate(
        { _id },
        {
          $set: {
            price,
          },
        },
        { new: true },
      );
    }

    // 🔔 Discord notification (price assigned)
    try {
      await this.discordHookService.sendDiPriceAssigned({
        di: updatedDi || pricing,
        price,
      });
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    return updatedDi;
  }
  async countIgnore(_id: string) {
    const di = await this.diModel.findOne({ _id });

    if (!di) {
      throw new Error('DI not found');
    }

    let newIgnoreCount = di.ignoreCount || 0;

    if (newIgnoreCount < 3) {
      newIgnoreCount++;
    }

    const updated = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          ignoreCount: newIgnoreCount,
        },
      },
      { new: true },
    );

    // 🔔 Discord notification (ignore incremented)
    try {
      await this.discordHookService.sendDiIgnored(updated);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    return updated;
  }
  async getAllRemarque(_idDI: string) {
    return await this.diModel.findOne({ _id: _idDI }).exec();
  }

  /**
   * Changing status di section
   */
  async changeStatusPending1(_id: string) {
    await this.assertTransitionAllowed(_id, STATUS_DI.Pending1.status);
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.Pending1.status,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in changeStatusPending1');
    }

    await this.statsService.updateStatus(_id, STATUS_DI.Pending1.status);

    // 🔔 Discord notification (Pending1)
    try {
      await this.discordHookService.sendDiStatusPending1(result);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });

    return result;
  }

  async changeStatusInDiagnostic(_id: any) {
    await this.assertTransitionAllowed(_id, STATUS_DI.InDiagnostic.status);
    const { di: result, previousStatus } =
      await this.diWorkflowService.transition({
        diId: _id,
        transitionKey: 'CHANGE_STATUS_IN_DIAGNOSTIC',
        skipRoleValidation: true,
      });

    try {
      if (previousStatus === STATUS_DI.DiagnosticInPause.status) {
        await this.discordHookService.sendDiagnosticResumed(result);
      } else {
        await this.discordHookService.sendDiagnosticStarted(result);
      }
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });
    return result;
  }

  async changeStatusInMagasin(_id: string) {
    await this.assertTransitionAllowed(_id, STATUS_DI.InMagasin.status);
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.InMagasin.status,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in changeStatusInMagasin');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.InMagasin.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.InMagasin.status);
    }

    // Discord notification
    try {
      await this.discordHookService.sendDiInMagasin(result);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });

    return result;
  }

  async changeStatusMagasinEstimation(_id: string) {
    await this.assertTransitionAllowed(_id, STATUS_DI.MagasinEstimation.status);
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.MagasinEstimation.status,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in changeStatusMagasinEstimation ');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.MagasinEstimation.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.MagasinEstimation.status,
      );
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });
    return result;
  }

  async changeStatusPending2(_id: string) {
    await this.assertTransitionAllowed(_id, STATUS_DI.Pending2.status);
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.Pending2.status,
        },
      },
      { new: true }, // 👈 important
    );

    if (!result) {
      throw new Error('Issue in changeStatusPending2');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.Pending2.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.Pending2.status);
    }

    // 🔔 Discord notification (status changed to Pending2)
    try {
      await this.discordHookService.sendDiStatusPending2(result);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    // existing socket notification
    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });

    return result;
  }

  async changeStatusPricing(_id: string, pricingRequestSentBy?: string | null) {
    await this.assertTransitionAllowed(_id, STATUS_DI.Pricing.status);
    const pricingRequestSentAt = new Date();
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.Pricing.status,
          pricingRequestSentAt,
          pricingRequestSentBy: pricingRequestSentBy ?? null,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in changeStatusPricing');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.Pricing.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.Pricing.status);
    }

    // 🔔 Discord notification (Pricing stage)
    try {
      await this.discordHookService.sendDiPricing(result);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    // existing notifications
    this.notificationGateway.sendNotifcationToAdmins(
      'Veuillez affecter le prix de ce DI',
    );

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });

    return result;
  }

  async sendDiToAdminsForPricing(
    diId: string,
    pricingRequestSentBy?: string | null,
  ) {
    const existing = await this.diModel.findOne({ _id: diId });

    if (!existing) {
      throw new NotFoundException(`DI ${diId} not found`);
    }

    if (existing.pricingRequestSentAt) {
      return existing;
    }

    return this.changeStatusPricing(diId, pricingRequestSentBy);
  }

  async changeStatusNegociate1(_id: string) {
    await this.assertTransitionAllowed(_id, STATUS_DI.Negotiation1.status);
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.Negotiation1.status,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in changeStatusNegociate1');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.Negotiation1.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.Negotiation1.status);
    }

    try {
      await this.discordHookService.sendDiNegotiation1(result);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });
    return result;
  }

  async changeStatusNegociate2(_id: string) {
    await this.assertTransitionAllowed(_id, STATUS_DI.Negotiation2.status);
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.Negotiation2.status,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in changeStatusNegociate2');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.Negotiation2.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.Negotiation2.status);
    }

    try {
      await this.discordHookService.sendDiNegotiation2(result);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });
    return result;
  }

  async changeStatusPending3(_id: string) {
    await this.assertTransitionAllowed(_id, STATUS_DI.Pending3.status);
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.Pending3.status,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in changeStatusPending3');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.Pending3.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.Pending3.status);
    }

    // 🔔 Discord notification (Pending3)
    try {
      await this.discordHookService.sendDiStatusPending3(result);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    // existing socket notification
    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });

    return result;
  }

  async changeStatusRepaire(_id: string) {
    await this.assertTransitionAllowed(_id, STATUS_DI.Reparation.status);
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.Reparation.status,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in changeStatusRepaire');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.Reparation.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.Reparation.status);
    }

    // 🔔 Discord notification (Reparation started)
    try {
      await this.discordHookService.sendDiInReparation(result);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });

    return result;
  }

  /**
   * Build + emit the WebSocket `updateTicket` event for a DI status change.
   *
   * Frontend filters (e.g. `tech-di-list.handleTechRealtimeMessage`) look
   * for `id_tech_diag` / `id_tech_rep` somewhere in the payload to decide
   * whether the connected tech should refresh. The Di entity does NOT
   * carry those fields — they live on the Stat — so we fetch the matching
   * Stat first and stitch its tech ids into `content.states` and `target`.
   *
   * Without this enrichment, the broadcast is delivered but every tech
   * client discards it as irrelevant, breaking real-time list/badge sync.
   */
  private async broadcastDiStatusChange(
    diId: string,
    diStatus: any,
  ): Promise<void> {
    const ignoreCount = (diStatus as any)?.ignoreCount ?? 0;
    const stat = await this.statModel
      .findOne(ignoreCount > 0 ? { _idDi: diId, ignoreCount } : { _idDi: diId })
      .lean()
      .exec();

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: {
        diStatus,
        states: {
          ...(stat ?? {}),
          _id: diId,
          _idDi: diId,
          status: diStatus?.status,
          id_tech_diag: stat?.id_tech_diag,
          id_tech_rep: stat?.id_tech_rep,
        },
      },
      target: {
        id_tech_diag: stat?.id_tech_diag,
        id_tech_rep: stat?.id_tech_rep,
      },
    });
  }

  async changeStatusInRepair(_id: string) {
    console.log('[changeStatusInRepair][service] start _id=', _id);
    await this.assertTransitionAllowed(_id, STATUS_DI.InReparation.status);

    // Mirror `changeStatusInDiagnostic` exactly: delegate to the workflow
    // service so the transition uses the same validated path the diagnostic
    // flow uses. CHANGE_STATUS_IN_REPAIR transitions the DI and the matching
    // Stat in one awaited unit; failures surface synchronously instead of
    // being swallowed by an unhandled rejection.
    const { di: result, previousStatus } =
      await this.diWorkflowService.transition({
        diId: _id,
        transitionKey: 'CHANGE_STATUS_IN_REPAIR',
        skipRoleValidation: true,
      });
    console.log(
      '[changeStatusInRepair][service] transition result=',
      result ? { _id: result._id, status: result.status } : null,
      'previousStatus=',
      previousStatus,
    );

    try {
      if (previousStatus === STATUS_DI.ReparationInPause.status) {
        await this.discordHookService.sendReparationResumed(result);
      } else {
        await this.discordHookService.sendReparationStarted(result);
      }
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    // Stamp the START of the current repair run leg — ONLY on a genuine
    // start/resume, i.e. when the previous status was NOT already INREPARATION.
    // A no-op modal re-open (INREPARATION → INREPARATION) must NOT move it, or
    // the elapsed anchor would reset on every refresh. The UI reads this as
    // `elapsed = rep_time + (now - repRunStartedAt)` while running.
    if (previousStatus !== STATUS_DI.InReparation.status) {
      const ignoreCount = (result as any)?.ignoreCount ?? 0;
      await this.statModel.updateOne(
        ignoreCount > 0 ? { _idDi: _id, ignoreCount } : { _idDi: _id },
        { $set: { repRunStartedAt: new Date() } },
      );
    }

    await this.broadcastDiStatusChange(_id, result);
    return result;
  }

  async changeStatusFinished(_id: string) {
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.Finished.status,
        },
      },
    );

    if (!result) {
      throw new Error('Issue in changeStatusFinished');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.Finished.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.Finished.status);
    }

    try {
      // Mongoose returns the pre-update doc when {new:true} is omitted, so
      // build a finished-shape from the current data before broadcasting.
      await this.discordHookService.sendDiFinished({
        ...(result as any).toObject?.(),
        status: STATUS_DI.Finished.status,
      });
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    const di = this.getDiById(_id);

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di, states: di },
      target: {},
    });
    return result;
  }

  /** Per-cycle workflow flags cleared whenever a DI is returned, so every
   *  retour cycle re-runs the FULL original flow with no phase showing as
   *  "already done" (e.g. "Envoyé aux admins" / "Composants confirmés").
   *  Cycle history is preserved separately in LogsDi (keyed by ignoreCount). */
  private readonly retourCycleReset = {
    pricingRequestSentAt: null,
    pricingRequestSentBy: null,
    componentsConfirmedAt: null,
    componentsConfirmedBy: null,
    isConfirmedComponentFromCoordinator: false,
    isSentToCoordinator: false,
    gotComposantFromMagasin: false,
    isOpenedOnce: false,
    confirmationComposant: null,
    handleSendingNotificationBetweenCoordinatorAndMagasin: 'IN_COORDINATOR',
  };

  async changeDiRetour1(_id: string, reason?: string) {
    const updated = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          ...this.retourCycleReset,
          status: STATUS_DI.Retour1.status,
          retourReason: reason ?? null,
          retourDate: new Date(),
        },
      },
      { new: true },
    );

    try {
      if (updated) await this.discordHookService.sendDiRetour(updated, 1);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di: updated, states: updated },
      target: {},
    });

    return updated;
  }
  async changeDiRetour2(_id: string, reason?: string) {
    const updated = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          ...this.retourCycleReset,
          status: STATUS_DI.Retour2.status,
          retourReason: reason ?? null,
          retourDate: new Date(),
        },
      },
      { new: true },
    );

    try {
      if (updated) await this.discordHookService.sendDiRetour(updated, 2);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di: updated, states: updated },
      target: {},
    });

    return updated;
  }
  async changeDiRetour3(_id: string, reason?: string) {
    const updated = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          ...this.retourCycleReset,
          status: STATUS_DI.Retour3.status,
          retourReason: reason ?? null,
          retourDate: new Date(),
        },
      },
      { new: true },
    );

    try {
      if (updated) await this.discordHookService.sendDiRetour(updated, 3);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di: updated, states: updated },
      target: {},
    });

    return updated;
  }
  async changeToPending1(_id: string) {
    const pending1 = await this.diModel.updateOne(
      { _id },
      { $set: { status: STATUS_DI.Pending1.status } },
    );

    const di = this.getDiById(_id);

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di, states: di },
      target: {},
    });

    return pending1;
  }

  async changeToDiagnosticInPause(_id: string) {
    const diStatus = await this.diModel.findOneAndUpdate(
      { _id },
      { $set: { status: STATUS_DI.DiagnosticInPause.status } },
      { new: true },
    );

    if (!diStatus) {
      throw new Error('Issue in DiagnosticInPause');
    }

    if (diStatus && diStatus.ignoreCount && diStatus.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.DiagnosticInPause.status,
        diStatus.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.DiagnosticInPause.status,
      );
    }

    try {
      await this.discordHookService.sendDiagnosticPaused(diStatus);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    await this.broadcastDiStatusChange(_id, diStatus);
    return diStatus;
  }

  async changeStateInReparationPause(_id: string) {
    const diStatus = await this.diModel.findOneAndUpdate(
      { _id },
      { $set: { status: STATUS_DI.ReparationInPause.status } },
      { new: true },
    );

    if (!diStatus) {
      throw new Error('Issue in ReparationInPause');
    }

    // Stat must be updated before broadcasting; tech-side queries read
    // Stat.status, so an unawaited update lets the WS-triggered refresh
    // observe stale INREPARATION while the new value is still in flight.
    if (diStatus.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.ReparationInPause.status,
        diStatus.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.ReparationInPause.status,
      );
    }

    try {
      await this.discordHookService.sendReparationPaused(diStatus);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    await this.broadcastDiStatusChange(_id, diStatus);

    return diStatus;
  }

  async changeToReparationInPause(_id: string) {
    const repInPause = await this.diModel.findOneAndUpdate(
      { _id },
      { $set: { status: STATUS_DI.ReparationInPause.status } },
    );

    if (!repInPause) {
      throw new Error('Issue in ReparationInPause');
    }

    if (repInPause.ignoreCount > 0) {
      this.statsService.updateStatus(
        _id,
        STATUS_DI.ReparationInPause.status,
        repInPause.ignoreCount,
      );
    } else {
      this.statsService.updateStatus(_id, STATUS_DI.ReparationInPause.status);
    }

    await this.broadcastDiStatusChange(_id, repInPause);

    return repInPause;
  }

  //! Query for statistics Here
  //1.Duree Moyenne Reparation
  async getTechStatisticsMoyenneReperation(techRep_id: string) {
    return await this.statModel
      .find({
        id_tech_rep: techRep_id,
        status: {
          $in: [
            STATUS_DI.Finished.status,
            STATUS_DI.Retour1.status,
            STATUS_DI.Retour2.status,
            STATUS_DI.Retour3.status,
          ],
        },
      })
      .catch(async (err) => {
        // Silent .catch returning err was a HIGH-severity bug — the
        // resolver returned an Error object that the FE rendered as a row.
        // Now we capture + return a safe empty array.
        await this.captureSilentFailure('tech-statistic-query', err);
        return [] as any;
      });
  }
  //1.Duree Moyenne Diagnostique
  async getTechStatisticsMoyenneDiagnostique(techDiag_id: string) {
    return await this.statModel
      .find({
        id_tech_diag: techDiag_id,
        status: {
          $in: [
            STATUS_DI.Pending1.status,
            STATUS_DI.Pending2.status,
            STATUS_DI.Pending3.status,
            STATUS_DI.Pricing.status,
            STATUS_DI.Negotiation1.status,
            STATUS_DI.Negotiation2.status,
            STATUS_DI.InMagasin.status,
            STATUS_DI.MagasinEstimation.status,
          ],
        },
      })
      .catch(async (err) => {
        // Silent .catch returning err was a HIGH-severity bug — the
        // resolver returned an Error object that the FE rendered as a row.
        // Now we capture + return a safe empty array.
        await this.captureSilentFailure('tech-statistic-query', err);
        return [] as any;
      });
  }
  //2. Taux de reperation reussie for Tech
  async getTauxRepReussiteByTech(techRep_id: string) {
    return await this.statModel
      .find({
        id_tech_rep: techRep_id,
        status: {
          $in: [
            STATUS_DI.Finished.status,
            STATUS_DI.Retour1.status,
            STATUS_DI.Retour2.status,
            STATUS_DI.Retour3.status,
          ],
        },
      })
      .catch(async (err) => {
        // Silent .catch returning err was a HIGH-severity bug — the
        // resolver returned an Error object that the FE rendered as a row.
        // Now we capture + return a safe empty array.
        await this.captureSilentFailure('tech-statistic-query', err);
        return [] as any;
      });
  }
  //2. Taux de reperation for Tech
  async getTauxReperationByTech(techRep_id: string) {
    return await this.statModel
      .find({
        id_tech_rep: techRep_id,
      })
      .catch(async (err) => {
        // Silent .catch returning err was a HIGH-severity bug — the
        // resolver returned an Error object that the FE rendered as a row.
        // Now we capture + return a safe empty array.
        await this.captureSilentFailure('tech-statistic-query', err);
        return [] as any;
      });
  }

  //3. Duree moyenne de reperation par type de panne
  async getDureeByCategoryDi(techRep_id: string) {
    // const statsByTech = await this.statModel.find({
    //   id_tech_rep: techRep_id,
    // });
    // const dilist = await Promise.all(
    //   statsByTech.map(async (el) => await this.getDiById(el._idDi)),
    // );
    // log(dilist, 'dilistdilist');
    // const combined = statsByTech.map((stat, index) => ({
    //   rep_time: stat.rep_time,
    //   di_category_id: dilist[index]?.di_category_id,
    // }));
  }
  //function that send confirmation composant from magasin to coordinatoor
  async sendComponentToConMagasinForConfirmation(_id: string) {
    const di = await this.diModel.findOne({ _id });
    if (!di) return null;

    let updated;

    if (di.ignoreCount && di.ignoreCount > 0) {
      updated = await this.logsDiService.isSentToCoordinator(
        _id,
        di.ignoreCount,
      );
    } else {
      updated = await this.diModel.findOneAndUpdate(
        { _id },
        {
          $set: {
            isSentToCoordinator: true,
            handleSendingNotificationBetweenCoordinatorAndMagasin: 'IN_MAGASIN',
          },
        },
        { new: true },
      );
    }

    if (!updated) return null;

    const payload = this.buildPayload(updated, {
      isSentToCoordinator: true,
      event: 'SENT_TO_COORDINATOR',
    });

    // 🔔 Discord notification
    try {
      await this.discordHookService.sendComponentsSentToCoordinator(updated);
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    // existing socket notification
    this.notificationGateway.sendComponentToCoordinatorFromMagasin(payload);

    return updated;
  }

  /** Draw down `quantity_stocked` for each EnStock composant used on a DI.
   *  Matches by the composant's unique name, floors at 0, and leaves
   *  Interne/Externe parts (sourced per-job, not from stock) untouched. */
  private async decrementStockForComposants(
    composants: Array<{ nameComposant?: string; quantity?: number }> = [],
  ): Promise<void> {
    for (const item of composants ?? []) {
      const name = item?.nameComposant;
      const qty = Number(item?.quantity) || 0;
      if (!name || qty <= 0) continue;
      // The app stores the in-stock status as 'En stock' (frontend value);
      // accept the legacy 'EnStock' enum spelling too.
      await this.composantModel.updateOne(
        { name, status_composant: { $in: ['En stock', 'EnStock'] } },
        [
          {
            $set: {
              quantity_stocked: {
                $max: [
                  0,
                  { $subtract: [{ $ifNull: ['$quantity_stocked', 0] }, qty] },
                ],
              },
            },
          },
        ],
      );
    }
  }

  async componentConfirmedFromCoordinator(
    _id: string,
    componentsConfirmedBy?: string | null,
  ) {
    const di = await this.diModel.findOne({ _id });
    if (!di) return null;

    let updated;
    const componentsConfirmedAt = new Date();

    if (di.ignoreCount && di.ignoreCount > 0) {
      // Pre-update log row (no {new:true}) → use its old confirm flag for
      // per-cycle idempotency and its parts for the stock draw-down.
      const logRow: any =
        await this.logsDiService.componentConfirmedFromCoordinator(
          _id,
          di.ignoreCount,
        );
      if (logRow && !logRow.isConfirmedComponentFromCoordinator) {
        try {
          await this.decrementStockForComposants(logRow.array_composants);
        } catch (err) {
          await this.captureDiscordFailure?.(
            'decrementStockForComposants',
            err,
            { diId: _id },
          );
        }
      }
      updated = await this.diModel.findOneAndUpdate(
        { _id },
        {
          $set: {
            componentsConfirmedAt,
            componentsConfirmedBy: componentsConfirmedBy ?? null,
          },
        },
        { new: true },
      );
    } else {
      // Atomic single-winner: only the request that flips componentsConfirmedAt
      // from unset → now draws down stock. The `componentsConfirmedAt: null`
      // guard (matches null OR missing) makes concurrent / double-clicked
      // confirms idempotent — a second call matches nothing, so it never
      // decrements the same parts twice.
      const flipped = await this.diModel.findOneAndUpdate(
        { _id, componentsConfirmedAt: null },
        {
          $set: {
            isConfirmedComponentFromCoordinator: true,
            handleSendingNotificationBetweenCoordinatorAndMagasin: 'DEFAULT',
            componentsConfirmedAt,
            componentsConfirmedBy: componentsConfirmedBy ?? null,
          },
        },
        { new: true },
      );
      if (flipped) {
        updated = flipped;
        try {
          await this.decrementStockForComposants(di.array_composants);
        } catch (err) {
          await this.captureDiscordFailure?.(
            'decrementStockForComposants',
            err,
            { diId: _id },
          );
        }
      } else {
        // Already confirmed earlier (idempotent retry) — no second draw-down.
        updated = await this.diModel.findOne({ _id });
      }
    }

    if (!updated) return null;

    const payload = this.buildPayload(updated, {
      isConfirmedComponentFromCoordinator: true,
      event: 'CONFIRMED_BY_COORDINATOR',
    });

    // 🔔 Discord notification
    try {
      await this.discordHookService.sendComponentsConfirmedByCoordinator(
        updated,
      );
    } catch (err) {
      await this.captureDiscordFailure('discord-notification', err);
    }

    // existing socket notification
    this.notificationGateway.sendComponentToMagasinFromCoordinator(payload);

    return updated;
  }

  async confirmDiComponents(
    diId: string,
    componentsConfirmedBy?: string | null,
  ) {
    const di = await this.diModel.findOne({ _id: diId });

    if (!di) {
      throw new NotFoundException(`DI ${diId} not found`);
    }

    if (di.componentsConfirmedAt) {
      return di;
    }

    return this.componentConfirmedFromCoordinator(diId, componentsConfirmedBy);
  }

  private buildPayload(di: any, extra: any) {
    return {
      _id: di._idnum,
      array_composants: di.array_composants,
      ...extra,
    };
  }
}
