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
import { STATUS_DI } from './di.status';
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
  ) {}

  async generateClientId(): Promise<number> {
    let indexClient = 0;
    const lastClient = await this.diModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );
    console.log('lastClient', lastClient);
    if (lastClient) {
      indexClient = +lastClient._idnum.substring(2);
      return indexClient + 1;
    }
    console.log('🥤[indexClient]:', indexClient);
    return indexClient;
  }

  async createDi(createDiInput: CreateDiInput): Promise<Di> {
    if (createDiInput.image.length !== 0) {
      const extension = getFileExtension(createDiInput.image);
      const buffer = Buffer.from(
        createDiInput.image.split(',')[1],
        'base64',
      ) as any;
      const randompdfFile = randomstring.generate({
        length: 12,
        charset: 'alphabetic',
      });
      fs.writeFileSync(
        join(__dirname, `../../docs/${randompdfFile}.${extension}`),
        buffer,
      );
      createDiInput.image = `${randompdfFile}.${extension}`;
    }
    // --
    const index = await this.generateClientId();
    console.log('🍺[index]:', index);
    createDiInput._id = `DI_${nanoid(4)}`;
    createDiInput._idnum = `DI${index}`;

    return await new this.diModel(createDiInput)
      .save()
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
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
    return await this.findbyId(_id);
  }

  async getAllNotOpeneddi() {
    return await this.diModel.find({ isOpenedOnce: false });
  }

  async addDevisPDF(_id: string, pdf: string) {
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
      return await this.logsDiService.addDevisPDFLogs(
        di._id,
        di.ignoreCount,
        `${randompdfFile}.${extension}`,
      );
    } else {
      return await this.diModel.updateOne(
        { _id },
        { $set: { devis: `${randompdfFile}.${extension}` } },
      );
    }
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
    if (di && di.ignoreCount && di.ignoreCount > 0) {
      return await this.logsDiService.addBLPDFLogs(
        di._id,
        di.ignoreCount,
        `${randompdfFile}.${extension}`,
      );
    } else {
      return await this.diModel.updateOne(
        { _id },
        { $set: { bon_de_livraison: `${randompdfFile}.${extension}` } },
      );
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
      return await this.logsDiService.addBCPDFLogs(
        di._id,
        di.ignoreCount,
        `${randompdfFile}.${extension}`,
      );
    } else {
      return await this.diModel.updateOne(
        { _id },
        { $set: { bon_de_commande: `${randompdfFile}.${extension}` } },
      );
    }
  }

  // async getDiById(_id:string){
  //   return await
  // }

  async updateDi(updateDi: UpdateDi) {
    const { _id, ...rest } = updateDi;
    const update = await this.diModel.findOneAndUpdate(
      { _id },
      { $set: { ...rest } },
      { new: true },
    );

    return update;
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
    console.log(search);

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
        case 'status':
          filter[field] = regex;
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

    console.log('🍉[filter]:', JSON.stringify(filter, null, 2));

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
          di_category_id: di.di_category_id?.category,
          location_id: di.location_id?.location_name ?? 'N/A',
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
          di_category_id: di.di_category_id?.category,
          location_id: di.location_id?.location_name ?? 'N/A',
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
      this.notificationGateway.confirmComposant(reply);
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
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: STATUS_DI.Pending1.role,
            status: STATUS_DI.Pending1.status,
          },
        },
      )
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  // InMagasin or InDiagnostic ==> PENDING2
  //from magasin or tech to coordinator
  async magasinTech_Pending2(_idDI: string): Promise<Di> {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: STATUS_DI.Pending2.role,
            status: STATUS_DI.Pending2.status,
          },
        },
      )
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }
  //TODO check if we need to delet this one
  // Negotiation1 or Negotiation2 ==> PENDING3
  // Admin or manager ==> coordinator
  async managerAdminManager_Pending3(_idDI: string): Promise<Di> {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: STATUS_DI.Pending3.role,
            status: STATUS_DI.Pending3.status,
          },
        },
      )
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }
  //New flow Nego1 & Nego2 sending DI to the INMagasin

  async managerAdminManager_InMagasin(
    _idDi: string,
    price: number,
    final_price: number,
  ): Promise<UpdateNego> {
    const pricingNeg = await this.diModel.findOne({ _id: _idDi });

    if (pricingNeg && pricingNeg.ignoreCount && pricingNeg.ignoreCount > 0) {
      console.log('log');
      return this.logsDiService.savePricing(
        _idDi,
        pricingNeg.ignoreCount,
        price,
        final_price,
      );
    } else {
      console.log('org');
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
    console.log(diag, 'diag info');
    const didata = await this.diModel.findOne({ _id: _idDI });
    if (didata && didata.ignoreCount && didata.ignoreCount > 0) {
      return await this.logsDiService.tech_startDiagnostic(
        didata._id,
        didata.ignoreCount,
        diag,
      );
    } else {
      return await this.diModel.findOneAndUpdate(
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
      );
    }
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

    if (result.ignoreCount > 0) {
      this.statsService.updateStatus(
        _id,
        STATUS_DI.Finished.status,
        result.ignoreCount,
      );
    }

    await this.statsService.updateStatus(_id, STATUS_DI.Finished.status);

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
    const result = await this.diModel.updateOne(
      { _id: _idDI },
      {
        $set: {
          current_roles: [Role.ADMIN_MANAGER, Role.ADMIN_TECH, Role.MANAGER],
          status: STATUS_DI.Annuler.status,
        },
      },
    );

    if (!result) {
      throw new Error('Issue in annulerDi ');
    }

    return result;
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

  // *Query For Coordinator
  async get_coordinatorDI(paginationConfig: PaginationConfigDi) {
    const queryCoordinator = {
      status: {
        $nin: [
          STATUS_DI.Created.status,
          STATUS_DI.Finished.status,
          STATUS_DI.Annuler.status,
        ],
      },
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
          $in: [
            STATUS_DI.Diagnostic.status,
            STATUS_DI.InDiagnostic.status,
            STATUS_DI.Reparation.status,
            STATUS_DI.InReparation.status,
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
  //! working here
  async getDiForMagasin(paginationConfig: PaginationConfigDi) {
    const queryCoordinator = {
      contain_pdr: true,
    };

    const { first, rows } = paginationConfig;
    const totalDiCount = await this.diModel.countDocuments(queryCoordinator);
    const di = await this.diModel
      .find({ isDeleted: false, ...queryCoordinator })
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first);

    return { di, totalDiCount };
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

    if (pricing && pricing.ignoreCount && pricing.ignoreCount > 0) {
      return await this.logsDiService.savePricing(
        pricing._id,
        pricing.ignoreCount,
        price,
      );
    } else {
      return await this.diModel.findOneAndUpdate(
        { _id },
        {
          $set: {
            price,
          },
        },
        { new: true },
      );
    }
  }

  async countIgnore(_id: string) {
    const countIgnore = await this.diModel.findOne({ _id });
    let { ignoreCount } = countIgnore;
    if (ignoreCount < 3) {
      ignoreCount++;
    }
    const isignore = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          ignoreCount,
        },
      },
    );

    if (isignore.matchedCount === 0) {
    }

    const v = await this.diModel.findOne({ _id });

    return v;
  }

  async getAllRemarque(_idDI: string) {
    return await this.diModel.findOne({ _id: _idDI }).exec();
  }

  /**
   * Changing status di section
   */
  async changeStatusPending1(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.Pending1.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.Pending1.status);

    const di = this.getDiById(_id);

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di, states: di },
      target: {},
    });
    return result;
  }

  async changeStatusInDiagnostic(_id: any) {
    console.log(_id);
    const result = await this.diModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          status: STATUS_DI.InDiagnostic.status,
        },
      },
      { new: true },
    );

    if (!result) {
      throw new Error('Error in update state in changeStatusInDiagnostic ');
    }

    if (result.ignoreCount > 0) {
      await this.statsService.updateStatus(
        _id,
        STATUS_DI.InDiagnostic.status,
        result.ignoreCount,
      );
    } else {
      await this.statsService.updateStatus(_id, STATUS_DI.InDiagnostic.status);
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
      throw new Error('Issue in changeStatusInMagasin ');
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
      throw new Error('Issue in changeStatusPending3 ');
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

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { result, states: result },
      target: {},
    });
    return result;
  }

  async changeStatusInRepair(_id: string) {
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

    const di = this.getDiById(_id);

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di, states: di },
      target: {},
    });
    return result;
  }

  async changeDiRetour1(_id: string) {
    const retour = await this.diModel.updateOne(
      { _id },
      { $set: { status: STATUS_DI.Retour1.status } },
    );

    const di = this.getDiById(_id);

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di, states: di },
      target: {},
    });

    return retour;
  }
  async changeDiRetour2(_id: string) {
    const retour = await this.diModel.updateOne(
      { _id },
      { $set: { status: STATUS_DI.Retour2.status } },
    );

    const di = this.getDiById(_id);

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di, states: di },
      target: {},
    });

    return retour;
  }
  async changeDiRetour3(_id: string) {
    const retour = await this.diModel.updateOne(
      { _id },
      { $set: { status: STATUS_DI.Retour3.status } },
    );

    const di = this.getDiById(_id);

    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di, states: di },
      target: {},
    });

    return retour;
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

    if (diStatus.ignoreCount > 0) {
      this.statsService.updateStatus(
        _id,
        STATUS_DI.ReparationInPause.status,
        diStatus.ignoreCount,
      );
    } else {
      this.statsService.updateStatus(_id, STATUS_DI.ReparationInPause.status);
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
    let isSentToCoordinator: any;
    const di = await this.diModel.findOne({ _id });
    if (di && di.ignoreCount && di.ignoreCount > 0) {
      isSentToCoordinator = await this.logsDiService.isSentToCoordinator(
        _id,
        di.ignoreCount,
      );
    } else {
      isSentToCoordinator = await this.diModel.findOneAndUpdate(
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

    if (isSentToCoordinator) {
      const dataToSend = {
        _id: isSentToCoordinator._id,
        array_composants: isSentToCoordinator.array_composants,
        isSentToCoordinator: isSentToCoordinator.isSentToCoordinator,
      };
      this.notificationGateway.sendComponenttoCoordinatorFromMagasin(
        dataToSend,
      );
    }

    return isSentToCoordinator;
  }

  async componentConfirmedFromCoordinator(_id: string) {
    let isConfirmedComponentFromCoordinator;
    const di = await this.diModel.findOne({ _id });
    if (di && di.ignoreCount && di.ignoreCount > 0) {
      isConfirmedComponentFromCoordinator =
        await this.logsDiService.componentConfirmedFromCoordinator(
          _id,
          di.ignoreCount,
        );
    } else {
      isConfirmedComponentFromCoordinator = await this.diModel.findOneAndUpdate(
        { _id },
        {
          $set: {
            isConfirmedComponentFromCoordinator: true,
            handleSendingNotificationBetweenCoordinatorAndMagasin: 'DEFAULT',
          },
        },
      );
    }

    if (isConfirmedComponentFromCoordinator) {
      const dataToSend = {
        _id: isConfirmedComponentFromCoordinator._id,
        array_composants: isConfirmedComponentFromCoordinator.array_composants,
        isConfirmedComponentFromCoordinator:
          isConfirmedComponentFromCoordinator.isConfirmedComponentFromCoordinator,
      };
      this.notificationGateway.sendComponenttoCoordinatorFromMagasin(
        dataToSend,
      );
    }

    return isConfirmedComponentFromCoordinator;
  }
}
