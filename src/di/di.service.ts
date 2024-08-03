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
  PaginationConfigDi,
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
import { error } from 'console';
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

@Injectable()
export class DiService {
  constructor(
    @InjectModel(Di.name) private diModel: Model<DiDocument>,
    @InjectModel(Composant.name)
    private composantModel: Model<ComposantDocument>,
    @InjectModel(Remarque.name)
    private readonly remarqueModel: Model<RemarqueDocument>,

    private readonly statsService: StatService,
    private readonly profileService: ProfileService,
    private readonly notificationGateway: NotificationsGateway,
  ) {}

  async generateDiId(): Promise<number> {
    let indexDi = 0;
    const lastDi = await this.diModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastDi) {
      console.log('is entered');
      indexDi = +lastDi._id.substring(2);
      console.log(indexDi, '== index');
      return indexDi + 1;
    }
    console.log(lastDi, 'lastDi');
    return indexDi;
  }
  async createDi(createDiInput: CreateDiInput): Promise<Di> {
    // --
    // the same code
    console.log(createDiInput.image, 'add service');
    const extension = getFileExtension(createDiInput.image);
    console.log(createDiInput.image, 'bufferr11');
    const buffer = Buffer.from(createDiInput.image.split(',')[1], 'base64');
    const randompdfFile = randomstring.generate({
      length: 12,
      charset: 'alphabetic',
    });
    fs.writeFileSync(
      join(__dirname, `../../docs/${randompdfFile}.${extension}`),
      buffer,
    );

    // --
    const index = await this.generateDiId();

    createDiInput._id = `DI${index}`;
    createDiInput.image = `${randompdfFile}.${extension}`;
    return await new this.diModel(createDiInput)
      .save()
      .then((res) => {
        console.log(res, 'Di');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }
  //nezih
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
      const di = await this.diModel.findById(_id).lean();

      if (!di)
        throw new Error(`Demande d'intervention with ID '${_id}' not found.`);

      return di;
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
    console.log('🥪');
    await this.statsService.deleteStat(_id);
    console.log('🍒');
    return await this.findbyId(_id);
  }

  async getAllNotOpeneddi() {
    return await this.diModel.find({ isOpenedOnce: false });
  }

  async getAllDi(paginationConfig: PaginationConfigDi) {
    const { first, rows } = paginationConfig;
    const totalDiCount = await this.diModel.countDocuments().exec();
    const diRecords = await this.diModel
      .find({ isDeleted: false })
      .populate('client_id', 'first_name last_name')
      .populate('createdBy', 'firstName lastName')
      .populate('location_id', 'location_name')
      .populate('di_category_id', 'category_Di')

      .limit(rows)
      .skip(first)
      .exec();
    console.log('🍊[diRecords]:', diRecords);
    const di = diRecords.map((di) => {
      let obj = {
        _id: di._id,
        title: di.title,
        description: di.description,
        ignoreCount: di.ignoreCount,
        can_be_repaired: di.can_be_repaired,
        bon_de_commande: di.bon_de_commande,
        bon_de_livraison: di.bon_de_livraison,
        contain_pdr: di.contain_pdr,
        current_roles: di.current_roles,
        array_composants: di.array_composants,
        status: di.status,
        image: di.image,
        client_id: di.client_id?.first_name ?? null,
        createdBy: `${di.createdBy?.firstName ?? ''} ${
          di.createdBy?.lastName ?? ''
        }`,
        // Use optional chaining and nullish coalescing for other properties as well
      };
      return obj;
    });

    console.log('🥘', di);
    return { di, totalDiCount };
  }

  async calculateTicketComposantPrice(ticketId: string) {
    const ticket = await this.diModel.findById(ticketId);
    if (!ticket) {
      throw new Error('Ticket not found');
    }

    const totalPrice = await Promise.all(
      ticket.array_composants.map(async (item) => {
        const composant = await this.composantModel.findOne({
          name: item.nameComposant,
        });
        return composant ? composant.prix_vente * item.quantity : 0;
      }),
    );
    // TODO substruct the quantity needed from compsant in stock
    return totalPrice.reduce((acc, curr) => acc + curr, 0);
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
    return await this.diModel
      .updateOne(
        { _id: _idDi },
        {
          $set: {
            price,
            final_price,
          },
        },
      )
      .then((res) => {
        if (res.modifiedCount > 0 && res.acknowledged) {
          return {
            price,
            final_price,
          };
        } else {
          throw new HttpException('Error', HttpStatus.INTERNAL_SERVER_ERROR);
        }
      })
      .catch((Error) => {
        throw new HttpException(Error, HttpStatus.INTERNAL_SERVER_ERROR);
      });
  }

  //coordinator sending to tech for  diagnostic
  async coordinator_ToDiag(_idDI: string) {
    const result = await this.diModel.updateOne(
      { _id: _idDI },
      {
        $set: {
          current_roles: STATUS_DI.Diagnostic.role,
          status: STATUS_DI.Diagnostic.status,
          isOpenedOnce: true,
        },
      },
    );

    if (result.matchedCount === 0) {
      throw new InternalServerErrorException('unable to find');
    }
    await this.statsService.updateStatus(_idDI, STATUS_DI.Diagnostic.status);
    return result;
  }
  //coordinator sending to tech for list of di to reperation
  async coordinator_ToRep(_idDI: string, tech_id: string) {
    const result = await this.diModel.updateOne(
      { _id: _idDI },
      {
        $set: {
          current_workers_ids: tech_id,
          current_roles: Role.TECH,
          status: STATUS_DI.Reparation,
        },
      },
    );

    if (result.matchedCount === 0) {
      throw new InternalServerErrorException('unable to find');
    }
    await this.statsService.updateStatus(_idDI, STATUS_DI.Reparation.status);
    return result;
  }

  //Tech finsih diagnostic
  async tech_startDiagnostic(_idDI: string, diag: DiagUpdate) {
    const result = await this.diModel.updateOne(
      { _id: _idDI },
      {
        $set: {
          can_be_repaired: diag.can_be_repaired,
          contain_pdr: diag.contain_pdr,
          remarque_tech_diagnostic: diag.remarque_tech_diagnostic,
          array_composants: diag.array_composants,
        },
      },
    );
    if (result.matchedCount === 0) {
      throw new InternalServerErrorException('unable to find');
    }
    if (diag.contain_pdr) {
      await this.statsService.updateStatus(
        _idDI,
        STATUS_DI.MagasinEstimation.status,
      );
    } else {
      await this.statsService.updateStatus(_idDI, STATUS_DI.Pending2.status);
    }
    return result;
  }

  //Tech closing diagnostic
  async tech_stopDiagnostic(_idDI: string) {
    const result = await this.diModel.updateOne(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.TECH,
          status: STATUS_DI.Diagnostic.status,
        },
      },
    );
    if (result.matchedCount === 0) {
      throw new InternalServerErrorException('unable to find');
    }
    await this.statsService.updateStatus(_idDI, STATUS_DI.Diagnostic.status);
    return result;
  }
  //Tech finsih diagnostic
  async tech_finishDiagnostic(_idDI: string, contain_pdr: boolean) {
    const result = await this.diModel.updateOne(
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
    if (result.matchedCount === 0) {
      throw new InternalServerErrorException('unable to find');
    }
    await this.statsService.updateStatus(_idDI, STATUS_DI.Diagnostic.status); // TODO nezih
    return result;
  }
  //Tech starting Reperation
  async tech_startReperation(_idDI: string) {
    const result = await this.diModel.updateOne(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.TECH,
          status: STATUS_DI.InReparation.status,
        },
      },
    );
    if (result.matchedCount === 0) {
      throw new InternalServerErrorException('unable to find');
    }
    await this.statsService.updateStatus(_idDI, STATUS_DI.InReparation.status);
    return result;
  }

  //Tech closing reperation
  async tech_stopReperation(_idDI: string) {
    const result = await this.diModel.updateOne(
      { _id: _idDI },
      {
        $set: {
          current_roles: Role.TECH,
          status: STATUS_DI.Reparation.status,
        },
      },
    );
    if (result.matchedCount === 0) {
      throw new InternalServerErrorException('unable to find');
    }
    await this.statsService.updateStatus(_idDI, STATUS_DI.Reparation.status);
    return result;
  }
  //Tech finsih Reperation
  async tech_finishReperation(_idDI: string, remarque: string) {
    console.log('🍗 fired');
    console.log('_idDI', _idDI);
    console.log('remarque', remarque);
    return await this.diModel.findOneAndUpdate(
      { _id: _idDI },
      {
        $set: {
          status: STATUS_DI.Finished.status,
          remarque_tech_repair: remarque,
        },
      },
      { new: true },
    );
  }

  //Coordiantor sending to the Admins for affecting price
  // PENDING2 => Pricing
  async coordinator_ToPricing(_idDI: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: [Role.ADMIN_MANAGER, Role.ADMIN_TECH],
            status: STATUS_DI.Pricing.status,
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

  //from admins to manager to give the first price
  // Pricing => Negotiation1
  async admins_Pricing(_idDI: string, price: number) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.MANAGER,
            status: STATUS_DI.Negotiation1.status,
            price: price,
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

  //from manager or AdminsManager to annuler DI
  // Negotiation1 or Negotiation2 => Annuler
  async annulerDi(_idDI: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: [Role.ADMIN_MANAGER, Role.ADMIN_TECH, Role.MANAGER],
            status: STATUS_DI.Annuler.status,
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
  //if DI confirmer we sent to coordiantor
  // Negotiation1  => Pending3
  async manager_Negotation_Pendin3(
    _idDI: string,
    discount_value: number,
    final_price: number,
  ) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.COORDINATOR,
            discount_value: discount_value,
            final_price: final_price,
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
  //if DI NOT confirmer we sent to Admin Manager
  // Negotiation1  => Negotiation2
  async manager_Negotation1_Negotation2(_idDI: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.ADMIN_MANAGER,
            status: STATUS_DI.Negotiation2.status,
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
  //Retour DI from finished to RETOUR 1
  //send by manager to coordinator so he can chose who gonna repair it
  async di_Retour1(_idDI: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.COORDINATOR,
            status: STATUS_DI.Retour1.status,
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
  async di_Retour2(_idDI: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.COORDINATOR,
            status: STATUS_DI.Retour2.status,
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
  async di_Retour3(_idDI: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.COORDINATOR,
            status: STATUS_DI.Retour3.status,
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

  //!Query for every role

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
      .limit(rows)
      .skip(first);

    return { di, totalDiCount };
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

  async getDiForMagasin(paginationConfig: PaginationConfigDi) {
    const queryCoordinator = { contain_pdr: true };
    const { first, rows } = paginationConfig;
    const totalDiCount = await this.diModel.countDocuments(queryCoordinator);
    const di = await this.diModel
      .find(queryCoordinator)
      .limit(rows)
      .skip(first);

    return { di, totalDiCount };
  }

  async affectinitialPrice(_id: string, price: number) {
    return await this.diModel.updateOne(
      { _id },
      {
        $set: {
          price,
        },
      },
    );
  }

  async countIgnore(_id: string) {
    const countIgnore = await this.diModel.findOne({ _id });
    let { ignoreCount } = countIgnore;
    if (ignoreCount < 3) {
      ignoreCount++;
    }
    console.log('🥘[ignoreCount]:', ignoreCount);
    const isignore = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          ignoreCount,
        },
      },
    );

    if (isignore.matchedCount === 0) {
      console.log('not found doc');
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
    return result;
  }

  async changeStatusInDiagnostic(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.InDiagnostic.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.InDiagnostic.status);
    return result;
  }

  async changeStatusInMagasin(_id: string) {
    console.log('🍩[_id]:', _id);
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.InMagasin.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.InMagasin.status);
    return result;
  }

  async changeStatusMagasinEstimation(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.MagasinEstimation.status,
        },
      },
    );

    await this.statsService.updateStatus(
      _id,
      STATUS_DI.MagasinEstimation.status,
    );
    return result;
  }

  async changeStatusPending2(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.Pending2.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.Pending2.status);
    return result;
  }

  async changeStatusPricing(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.Pricing.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.Pricing.status);
    this.notificationGateway.sendNotifcationToAdmins(
      'Veuillez affecter le prix de ce DI',
    );
    return result;
  }

  async changeStatusNegociate1(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.Negotiation1.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.Negotiation1.status);
    return result;
  }

  async changeStatusNegociate2(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.Negotiation2.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.Negotiation2.status);
    return result;
  }

  async changeStatusPending3(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.Pending3.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.Pending3.status);
    return result;
  }

  async changeStatusRepaire(_id: string) {
    console.log('🍦[_id]:', _id);
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.Reparation.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.Reparation.status);
    return result;
  }

  async changeStatusInRepair(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.InReparation.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.InReparation.status);
    return result;
  }

  async changeStatusFinished(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          status: STATUS_DI.Finished.status,
        },
      },
    );

    await this.statsService.updateStatus(_id, STATUS_DI.Finished.status);
    return result;
  }

  async sendConfirmerRecoitComposant(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          gotComposantFromMagasin: 'REQUEST',
        },
      },
    );

    const stat = await this.statsService.findUserLinkedToConcernedDi(_id);
    const profile = this.profileService.findProlileById(stat.id_tech_rep);
    this.notificationGateway.confirmComposant(profile);

    return result;
  }

  async responseConfirmerRecoitComposant(_id: string) {
    const result = await this.diModel.updateOne(
      { _id },
      {
        $set: {
          gotComposantFromMagasin: 'RESPONSE',
        },
      },
    );

    this.notificationGateway.resConfirmComposant(
      'Les documents et composants confirmé',
    );

    return result;
  }

  async changeDiRetour(_id: string) {
    return await this.diModel.updateOne(
      { _id },
      { $set: { status: STATUS_DI.Pending3.status } },
    );
  }

  async changeToPending1(_id: string) {
    return await this.diModel.updateOne(
      { _id },
      { $set: { status: STATUS_DI.Pending1.status } },
    );
  }

  // doc section :
  //   function getFileExtension(base64) {
  //   const metaData = base64.split(',')[0];
  //   const fileType = metaData.split(':')[1].split(';')[0];
  //   const extension = fileType.split('/')[1];
  //   return extension;
  // }

  // async create(createTicketInput: CreateTicketInput) {
  //   console.log(createTicketInput, 'add service');
  //   const extension = getFileExtension(createTicketInput.image);
  //   console.log(createTicketInput.image, 'bufferr11');
  //   const buffer = Buffer.from(createTicketInput.image.split(',')[1], 'base64');
  //   const randompdfFile = randomstring.generate({
  //     length: 12,
  //     charset: 'alphabetic',
  //   });
  //   fs.writeFileSync(
  //     join(__dirname, `../../pdf/${randompdfFile}.${extension}`),
  //     buffer,
  //   );
  //   const index = await this.generateClientId();
  //   console.log('index ticket', index);
  //   createTicketInput._id = `T${index}`;
  //   console.log(createTicketInput._id, 'for saving');
  //   createTicketInput.image = `${randompdfFile}.${extension}`;
  //   console.log(createTicketInput.image, 'image');
  //   return await new this.ticketModel(createTicketInput)
  //     .save()
  //     .then((res) => {
  //       console.log(res, 'ticket added');
  //       return res;
  //     })
  //     .catch((err) => {
  //       console.log(err, 'ticket error');
  //       return err;
  //     });
  // }
  // HTML
  //  <input
  //         nbInput
  //         fullWidth
  //         placeholder="Textarea"
  //         formControlName="image"
  //         type="file"
  //         (change)="onSelectFile($event)"
  //       />
  //     </div>

  // onSelectFile(image: any) {
  //   const file = image.target.files && image.target.files[0];

  //   if (file) {
  //     var reader = new FileReader();
  //     reader.readAsDataURL(file);

  //     reader.onload = (event) => {
  //       console.log(event, 'event onload');
  //       this.imageStr = reader.result;
  //     };
  //   }

  //   console.log(this.imageStr, 'pdf str');
  // }
}
