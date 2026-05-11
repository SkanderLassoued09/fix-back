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
  COORDINATOR_STATUS_DI_VALUES,
  MAGASIN_STATUS_DI_VALUES,
  STATUS_DI,
  TECH_STATUS_DI_VALUES,
} from './di.status';
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
  ) {}

  async generateClientId(): Promise<number> {
    let indexClient = 0;
    const lastClient = await this.diModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );
    if (lastClient) {
      indexClient = +lastClient._idnum.substring(2);
      return indexClient + 1;
    }
    return indexClient;
  }

  async createDi(createDiInput: CreateDiInput): Promise<any> {
    try {
      // 🖼️ Handle image
      if (createDiInput.image?.length) {
        const extension = getFileExtension(createDiInput.image);

        const buffer = Buffer.from(createDiInput.image.split(',')[1], 'base64');

        const fileName = `${randomstring.generate({
          length: 12,
          charset: 'alphabetic',
        })}.${extension}`;

        fs.writeFileSync(join(__dirname, `../../docs/${fileName}`), buffer);

        createDiInput.image = fileName;
      }

      // 🆔 Generate IDs
      const index = await this.generateClientId();
      createDiInput._id = `DI_${nanoid(4)}`;
      createDiInput._idnum = `DI${index}`;

      // 💾 Save
      const di = await new this.diModel(createDiInput).save();
      await this.syncEmplacementStats(di.location_id as any);

      // 🔔 Notify (only if pending)
      if (di.status === 'PENDING1') {
        this.discordHookService.sendDiPendingNotification(di);
      }

      return di;
    } catch (error) {
      console.error('createDi error:', error);
      throw new Error('Failed to create DI');
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
    const extension = getFileExtension(pdf);
    const buffer = Buffer.from(pdf.split(',')[1], 'base64');

    const randompdfFile = randomstring.generate({
      length: 12,
      charset: 'alphabetic',
    });

    const fileName = `${randompdfFile}.${extension}`;

    fs.writeFileSync(join(__dirname, `../../docs/${fileName}`), buffer);

    const di = await this.diModel.findOne({ _id });

    let result;

    if (di && di.ignoreCount && di.ignoreCount > 0) {
      result = await this.logsDiService.addDevisPDFLogs(
        di._id,
        di.ignoreCount,
        fileName,
      );
    } else {
      result = await this.diModel.updateOne(
        { _id },
        { $set: { devis: fileName } },
      );
    }

    // 🔔 Discord notification (Devis uploaded)
    try {
      await this.discordHookService.sendDiDevisUploaded({
        di,
        fileName,
      });
    } catch (err) {
      console.error('Discord notification failed:', err);
    }

    return result;
  }

  async addBlPDF(_id: string, pdf: string) {
    const extension = getFileExtension(pdf);
    const buffer = Buffer.from(pdf.split(',')[1], 'base64') as any;

    const randompdfFile = randomstring.generate({
      length: 12,
      charset: 'alphabetic',
    });
    fs.writeFileSync(
      join(__dirname, `../../docs/${randompdfFile}.${extension}`),
      buffer,
    );
    const di = await this.diModel.findOne({ _id });
    const fileName = `${randompdfFile}.${extension}`;
    if (di && di.ignoreCount && di.ignoreCount > 0) {
      let addbllogspdf = await this.logsDiService.addBLPDFLogs(
        di._id,
        di.ignoreCount,
        fileName,
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
        console.error('Discord notification failed:', err);
      }

      return addbllogspdf;
    } else {
      // Use findOneAndUpdate({ new: true }) so the post-update document
      // (with bon_de_livraison populated) is what we both broadcast and
      // return. The previous updateOne left `di` as the pre-update doc,
      // so any consumer of the WS payload received stale data.
      const updatedDi = await this.diModel.findOneAndUpdate(
        { _id },
        { $set: { bon_de_livraison: fileName } },
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
        console.error('Discord notification failed:', err);
      }

      return updatedDi;
    }
  }

  async addFacturePDF(_id: string, pdf: string) {
    const extension = getFileExtension(pdf);
    const buffer = Buffer.from(pdf.split(',')[1], 'base64') as any;

    const randompdfFile = randomstring.generate({
      length: 12,
      charset: 'alphabetic',
    });
    fs.writeFileSync(
      join(__dirname, `../../docs/${randompdfFile}.${extension}`),
      buffer,
    );
    const di = await this.diModel.findOne({ _id });
    if (di && di.ignoreCount && di.ignoreCount > 0) {
      return await this.logsDiService.addFacturePDFLogs(
        di._id,
        di.ignoreCount,
        `${randompdfFile}.${extension}`,
      );
    } else {
      return await this.diModel.updateOne(
        { _id },
        { $set: { facture: `${randompdfFile}.${extension}` } },
      );
    }
  }

  async addBCPDF(_id: string, pdf: string) {
    const extension = getFileExtension(pdf);
    const buffer = Buffer.from(pdf.split(',')[1], 'base64');

    const randompdfFile = randomstring.generate({
      length: 12,
      charset: 'alphabetic',
    });

    const fileName = `${randompdfFile}.${extension}`;

    fs.writeFileSync(join(__dirname, `../../docs/${fileName}`), buffer);

    const di = await this.diModel.findOne({ _id });

    let result;

    if (di && di.ignoreCount && di.ignoreCount > 0) {
      result = await this.logsDiService.addBCPDFLogs(
        di._id,
        di.ignoreCount,
        fileName,
      );
    } else {
      result = await this.diModel.updateOne(
        { _id },
        { $set: { bon_de_commande: fileName } },
      );
    }

    // 🔔 Discord notification (BC uploaded)
    try {
      await this.discordHookService.sendDiBCUploaded({
        di,
        fileName,
      });
    } catch (err) {
      console.error('Discord notification failed:', err.message);
    }

    return result;
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
    // facture
    const extension = getFileExtension(facture);
    const buffer = Buffer.from(facture.split(',')[1], 'base64') as any;

    const randompdfFile = randomstring.generate({
      length: 12,
      charset: 'alphabetic',
    });
    fs.writeFileSync(
      join(__dirname, `../../docs/${randompdfFile}.${extension}`),
      buffer,
    );
    //  bl
    const extensionbl = getFileExtension(bl);
    const bufferbl = Buffer.from(facture.split(',')[1], 'base64') as any;

    const randompdfFilebl = randomstring.generate({
      length: 12,
      charset: 'alphabetic',
    });
    fs.writeFileSync(
      join(__dirname, `../../docs/${randompdfFilebl}.${extensionbl}`),
      bufferbl,
    );

    //  save
    return await this.diModel.updateOne(
      { _id },
      {
        $set: {
          facture: `${randompdfFile}.${extension}`,
          bon_de_livraison: `${randompdfFilebl}.${extensionbl}`,
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
          price: di.price ?? 'N/A',
          final_price: di.final_price ?? 'N/A',
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
          price: di.price ?? 'N/A',
          final_price: di.final_price ?? 'N/A',
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

  // from Created ==> PENDING1
  // from Manager => coordinator
  async manager_Pending1(_idDI: string): Promise<Di> {
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
      console.error('Discord notification failed:', err);
    }

    return result.di;
  }
  //TODO check if we need to delet this one
  // Negotiation1 or Negotiation2 ==> PENDING3
  // Admin or manager ==> coordinator
  async managerAdminManager_Pending3(_idDI: string): Promise<Di> {
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
      return await this.diModel.findOneAndUpdate(
        { _id: _idDi },
        {
          $set: {
            price,
            final_price,
          },
        },
      );
    }
  }

  //coordinator sending to tech for  diagnostic
  async coordinator_ToDiag(_idDI: string) {
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
      console.error('Discord notification failed:', err);
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
      console.error('Discord notification failed:', err);
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
      console.error('Discord notification failed:', err);
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

    // ✅ Coordinator base filter
    const filter: any = {
      status: { $in: COORDINATOR_STATUS_DI_VALUES },
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
          price: di.price ?? 'N/A',
          final_price: di.final_price ?? 'N/A',
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
    const queryCoordinator = {
      status: { $in: COORDINATOR_STATUS_DI_VALUES },
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

    const coordDiList = di.map(async (di) => {
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
    });

    return { di: coordDiList, totalDiCount };
  }
  // Query For Tech
  async getAll_TechDI(tech_id: string) {
    return await this.diModel
      .find({
        current_workers_ids: tech_id,
        status: {
          $in: TECH_STATUS_DI_VALUES,
        },
      })
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
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
      console.error('Discord notification failed:', err);
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
      console.error('Discord notification failed:', err);
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
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });

    return result;
  }

  async changeStatusInDiagnostic(_id: any) {
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
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });
    return result;
  }

  async changeStatusInMagasin(_id: string) {
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
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });

    return result;
  }

  async changeStatusMagasinEstimation(_id: string) {
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
      console.error('Discord notification failed:', err);
    }

    // existing socket notification
    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });

    return result;
  }

  async changeStatusPricing(_id: string) {
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.Pricing.status,
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
      console.error('Discord notification failed:', err);
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

  async changeStatusNegociate1(_id: string) {
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
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });
    return result;
  }

  async changeStatusNegociate2(_id: string) {
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
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });
    return result;
  }

  async changeStatusPending3(_id: string) {
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
      console.error('Discord notification failed:', err);
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
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });

    return result;
  }

  async changeStatusInRepair(_id: string) {
    // Capture the previous status BEFORE the update so we can choose the
    // right embed (started vs resumed). findOneAndUpdate({new: true})
    // would otherwise only return the post-update snapshot.
    const previous = await this.diModel.findOne({ _id });
    const previousStatus = previous?.status;

    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.InReparation.status,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Issue in changeStatusInRepair');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.InReparation.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.InReparation.status);
    }

    try {
      if (previousStatus === STATUS_DI.ReparationInPause.status) {
        await this.discordHookService.sendReparationResumed(result);
      } else {
        await this.discordHookService.sendReparationStarted(result);
      }
    } catch (err) {
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });
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
      console.error('Discord notification failed:', err);
    }

    const di = this.getDiById(_id);

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di, states: di },
      target: {},
    });
    return result;
  }

  async changeDiRetour1(_id: string) {
    const updated = await this.diModel.findOneAndUpdate(
      { _id },
      { $set: { status: STATUS_DI.Retour1.status } },
      { new: true },
    );

    try {
      if (updated) await this.discordHookService.sendDiRetour(updated, 1);
    } catch (err) {
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di: updated, states: updated },
      target: {},
    });

    return updated;
  }
  async changeDiRetour2(_id: string) {
    const updated = await this.diModel.findOneAndUpdate(
      { _id },
      { $set: { status: STATUS_DI.Retour2.status } },
      { new: true },
    );

    try {
      if (updated) await this.discordHookService.sendDiRetour(updated, 2);
    } catch (err) {
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di: updated, states: updated },
      target: {},
    });

    return updated;
  }
  async changeDiRetour3(_id: string) {
    const updated = await this.diModel.findOneAndUpdate(
      { _id },
      { $set: { status: STATUS_DI.Retour3.status } },
      { new: true },
    );

    try {
      if (updated) await this.discordHookService.sendDiRetour(updated, 3);
    } catch (err) {
      console.error('Discord notification failed:', err);
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
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { diStatus, states: diStatus },
      target: {},
    });
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
      console.error('Discord notification failed:', err);
    }

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { diStatus, states: diStatus },
      target: {},
    });

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

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { repInPause, states: repInPause },
      target: {},
    });

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
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
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
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
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
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }
  //2. Taux de reperation for Tech
  async getTauxReperationByTech(techRep_id: string) {
    return await this.statModel
      .find({
        id_tech_rep: techRep_id,
      })
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
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
      console.error('Discord notification failed:', err);
    }

    // existing socket notification
    this.notificationGateway.sendComponentToCoordinatorFromMagasin(payload);

    return updated;
  }

  async componentConfirmedFromCoordinator(_id: string) {
    const di = await this.diModel.findOne({ _id });
    if (!di) return null;

    let updated;

    if (di.ignoreCount && di.ignoreCount > 0) {
      updated = await this.logsDiService.componentConfirmedFromCoordinator(
        _id,
        di.ignoreCount,
      );
    } else {
      updated = await this.diModel.findOneAndUpdate(
        { _id },
        {
          $set: {
            isConfirmedComponentFromCoordinator: true,
            handleSendingNotificationBetweenCoordinatorAndMagasin: 'DEFAULT',
          },
        },
        { new: true },
      );
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
      console.error('Discord notification failed:', err);
    }

    // existing socket notification
    this.notificationGateway.sendComponentToMagasinFromCoordinator(payload);

    return updated;
  }
  private buildPayload(di: any, extra: any) {
    return {
      _id: di._idnum,
      array_composants: di.array_composants,
      ...extra,
    };
  }

}
