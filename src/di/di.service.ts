import { Injectable } from '@nestjs/common';
import {
  CreateDiInput,
  DiagUpdate,
  PaginationConfigDi,
} from './dto/create-di.input';
import { InjectModel } from '@nestjs/mongoose';
import { Di, DiDocument } from './entities/di.entity';
import { Model } from 'mongoose';
import { STATUS_DI } from './di.status';
import { Role } from 'src/auth/roles';

@Injectable()
export class DiService {
  constructor(@InjectModel(Di.name) private diModel: Model<DiDocument>) {}
  async create(createDiInput: CreateDiInput) {
    return await new this.diModel(createDiInput).save();
  }
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
    const index = await this.generateDiId();

    createDiInput._id = `DI${index}`;
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

  async getAllDi(paginationConfig: PaginationConfigDi) {
    const { first, rows } = paginationConfig;
    const totalDiCount = await this.diModel.countDocuments().exec();
    const diRecords = await this.diModel
      .find({})
      .populate('client_id', 'first_name last_name')
      .populate('createdBy', 'firstName lastName')
      .populate('location_id', 'location_name')
      .populate('remarque_id', 'remarque_manager')
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
        can_be_repaired: di.can_be_repaired,
        bon_de_commande: di.bon_de_commande,
        bon_de_livraison: di.bon_de_livraison,
        contain_pdr: di.contain_pdr,
        current_roles: di.current_roles,

        status: di.status,
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

  //coordinator sending to tech for  diagnostic
  async coordinator_ToDiag(_idDI: string, tech_id: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_workers_ids: tech_id,
            current_roles: STATUS_DI.Diagnostic.role,
            status: STATUS_DI.Diagnostic.status,
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
  //coordinator sending to tech for list of di to reperation
  async coordinator_ToRep(_idDI: string, tech_id: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_workers_ids: tech_id,
            current_roles: Role.TECH,
            status: STATUS_DI.Reparation,
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

  //Tech starting diagnostic
  async tech_startDiagnostic(_idDI: string, diag: DiagUpdate) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.TECH,
            status: STATUS_DI.InDiagnostic.status,
            can_be_repaired: diag.can_be_repaired,
            contain_pdr: diag.contain_pdr,
            remarqueTech: diag.remarqueTech,
            array_composants: diag.array_composants,
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

  //Tech closing diagnostic
  async tech_stopDiagnostic(_idDI: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.TECH,
            status: STATUS_DI.Diagnostic.status,
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
  //Tech finsih diagnostic
  async tech_finishDiagnostic(_idDI: string, contain_pdr: boolean) {
    return this.diModel
      .updateOne(
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
      )
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }
  //Tech starting Reperation
  async tech_startReperation(_idDI: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.TECH,
            status: STATUS_DI.InReparation.status,
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

  //Tech closing reperation
  async tech_stopReperation(_idDI: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.TECH,
            status: STATUS_DI.Reparation.status,
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
  //Tech finsih Reperation
  async tech_finishReperation(_idDI: string) {
    return this.diModel
      .updateOne(
        { _id: _idDI },
        {
          $set: {
            current_roles: Role.TECH,
            status: STATUS_DI.Finished.status,
          },
        },
      )
      .then((res) => {
        console.log('tech_finishReperation');
        return res;
      })
      .catch((err) => {
        return err;
      });
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
}

/**
 *
 */
