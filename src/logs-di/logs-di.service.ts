import { Injectable, NotFoundException } from '@nestjs/common';
import { UpdateLogsDiInput } from './dto/update-logs-di.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiLogsDocument, LogsDi } from './entities/logs-di.entity';
import { DiagUpdateLogs } from './dto/create-logs-di.input';

import {
  Composant,
  ComposantDocument,
} from 'src/composant/entities/composant.entity';
import { v4 as uuidv4 } from 'uuid';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';
@Injectable()
export class LogsDiService {
  constructor(
    @InjectModel(LogsDi.name)
    private readonly logsDiModel: Model<DiLogsDocument>,
    @InjectModel(Composant.name)
    private composantModel: Model<ComposantDocument>,
    private readonly operationalErrorService: OperationalErrorService,
  ) {}

  async generateDiId(): Promise<number> {
    let indexDIL = 0;
    const lastDIL = await this.logsDiModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastDIL) {
      indexDIL = +lastDIL._id.substring(3);
      return indexDIL + 1;
    }
    return indexDIL;
  }

  async create(_idDi: string, idIgnore: number) {
    const index = await this.generateDiId();
    let _id = uuidv4();
    return await new this.logsDiModel({ _id, _idDi, idIgnore }).save();
  }

  async getLogsById(idIgnore: number, _idDi: string) {
    try {
      const logsDi = await this.logsDiModel.findOne({ _idDi, idIgnore });

      // if (!logsDi) {
      //   throw new Error(
      //     `logsDi not found for id ${_idDi} and ignore count ${idIgnore}`,
      //   );
      // }
      return logsDi;
    } catch (error) {
      // Was a no-op try/catch — captured now so Mongo failures land in
      // the daily log file + Discord ops channel before rethrow.
      await this.operationalErrorService.capture({
        module: 'logs-di',
        submodule: 'logsDiService',
        method: 'GET_LOGS_BY_ID',
        severity: 'MEDIUM',
        error: 'Failed to load DI logs by id',
        message: (error as Error)?.message ?? String(error),
        payload: { _idDi, idIgnore },
      });
      throw error;
    }
  }

  // async updatePricing(_id:number,price){
  //   const pricing  = await this.logsDiModel.findOneAndUpdate({_id},{$set:{price}})
  // }

  //Tech finsih diagnostic
  async tech_startDiagnostic(
    _idDi: string,
    idIgnore: number,
    diag: DiagUpdateLogs,
  ) {
    try {
      const result = await this.logsDiModel.findOneAndUpdate(
        { _idDi, idIgnore },
        {
          $set: {
            can_be_repaired: diag.can_be_repaired,
            contain_pdr: diag.contain_pdr,
            remarque_tech_diagnostic: diag.remarque_tech_diagnostic,
            isErrorFromFixtronix: diag.isErrorFromFixtronix ?? null,
            array_composants: diag.array_composants,
            di_category_id: diag.di_category_id,
          },
        },
      );
      if (!result) {
        throw new Error('Issue when saving data when tech save logs');
      }

      return result;
    } catch (error) {
      // No-op rethrow was here previously — wired through capture now so
      // operations can see when a tech's diagnostic save fails.
      await this.operationalErrorService.capture({
        module: 'logs-di',
        submodule: 'logsDiService',
        method: 'TECH_START_DIAGNOSTIC',
        severity: 'HIGH',
        error: 'Failed to persist tech diagnostic logs',
        message: (error as Error)?.message ?? String(error),
        payload: { _idDi, idIgnore },
      });
      throw error;
    }
  }
  async savePricing(
    _idDi: string,
    idIgnore: number,
    price: number,
    final_price?: number,
  ) {
    try {
      if (final_price) {
        return await this.logsDiModel.findOneAndUpdate(
          { _idDi, idIgnore },
          { $set: { price, final_price } },
        );
      } else {
        return await this.logsDiModel.findOneAndUpdate(
          { _idDi, idIgnore },
          { $set: { price } },
        );
      }
    } catch (error) {
      // Previously two silent `.catch((err) => return err)` — pricing
      // flows received an Error object as if pricing succeeded. Now we
      // capture (HIGH — financial fields) and rethrow the original so
      // the caller sees the real Mongo cause.
      await this.operationalErrorService.capture({
        module: 'logs-di',
        submodule: 'logsDiService',
        method: 'SAVE_PRICING',
        severity: 'HIGH',
        error: 'Failed to persist pricing logs',
        message: (error as Error)?.message ?? String(error),
        payload: { _idDi, idIgnore, price, final_price },
      });
      throw error;
    }
  }

  async calculateComposantTicketPrice(_idDi: string, idIgnore: number) {
    const diLog = await this.logsDiModel.findOne({ _idDi, idIgnore });
    if (!diLog || !Array.isArray(diLog.array_composants)) {
      // Previously crashed with `Cannot read properties of null` if the
      // log row was missing. Capture + return 0 so pricing flows degrade
      // gracefully (caller sees "no priced components" rather than 500).
      await this.operationalErrorService.capture({
        module: 'logs-di',
        submodule: 'logsDiService',
        method: 'CALCULATE_COMPOSANT_TICKET_PRICE',
        severity: 'MEDIUM',
        error: 'DI log row missing or has no array_composants',
        message: `No diLog for _idDi=${_idDi} idIgnore=${idIgnore}`,
        payload: { _idDi, idIgnore, diLogExists: !!diLog },
      });
      return 0;
    }
    const totalPrice = await Promise.all(
      diLog.array_composants.map(async (item) => {
        const composant = await this.composantModel.findOne({
          name: item.nameComposant,
        });

        return composant ? composant.prix_vente * item.quantity : 0;
      }),
    );
    // TODO substruct the quantity needed from compsant in stock.
    return totalPrice.reduce((acc, curr) => acc + curr, 0);
  }

  async addDevisPDFLogs(_idDi: string, idIgnore: number, pdf: string) {
    return await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      { $set: { devis: pdf } },
      { new: true },
    );
  }
  async addBCPDFLogs(_idDi: string, idIgnore: number, pdf: string) {
    return await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      { $set: { bon_de_commande: pdf } },
      { new: true },
    );
  }
  //Bon de livraison
  async addBLPDFLogs(_idDi: string, idIgnore: number, pdf: string) {
    const bl = await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      { $set: { bon_de_livraison: pdf } },
      { new: true },
    );
    return bl;
  }
  async addFacturePDFLogs(_idDi: string, idIgnore: number, pdf: string) {
    return await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      { $set: { facture: pdf } },
      { new: true },
    );
  }

  async calculateticketComposantPriceLogs(_id: string, idIgnore: number) {
    const ticket = await this.logsDiModel.findOne({ _id, idIgnore });
    if (!ticket || !Array.isArray(ticket.array_composants)) {
      await this.operationalErrorService.capture({
        module: 'logs-di',
        submodule: 'logsDiService',
        method: 'CALCULATE_TICKET_COMPOSANT_PRICE_LOGS',
        severity: 'MEDIUM',
        error: 'Ticket log row missing or has no array_composants',
        message: `No ticket for _id=${_id} idIgnore=${idIgnore}`,
        payload: { _id, idIgnore, ticketExists: !!ticket },
      });
      return 0;
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

  async isSentToCoordinator(_idDi: string, idIgnore: number) {
    return await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      {
        $set: {
          isSentToCoordinator: true,
          handleSendingNotificationBetweenCoordinatorAndMagasin: 'IN_MAGASIN',
        },
      },
      { new: true },
    );
  }
  async componentConfirmedFromCoordinator(_idDi: string, idIgnore: number) {
    return await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      {
        $set: {
          isConfirmedComponentFromCoordinator: true,
          handleSendingNotificationBetweenCoordinatorAndMagasin: 'DEFAULT',
        },
      },
    );
  }

  async tech_finishReperationLogs(
    _idDi: string,
    idIgnore: number,
    remarque: string,
  ) {
    return await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      {
        $set: {
          remarque_tech_repair: remarque,
        },
      },
      { new: true },
    );
  }

  async setSelectedComponentAsDoneLogs(
    _idDi: string,
    diIgnore: number,
    nameComponent: string,
  ) {
    try {
      // Find the document with the specific component
      const updatedDocument = await this.logsDiModel.findOneAndUpdate(
        {
          _idDi: _idDi,
          idIgnore: diIgnore,
          'array_composants.nameComposant': nameComponent,
        },
        { $set: { 'array_composants.$.isUpdated': true } }, // Update only the matched component
        { new: true }, // Return the updated document
      );

      if (!updatedDocument) {
        throw new NotFoundException(`Document or component not found.`);
      }

      return updatedDocument;
    } catch (error) {
      // Previously wrapped in `throw new InternalServerErrorException(error)`
      // — lost the original Mongo / Nest exception class. Now we capture
      // and rethrow the ORIGINAL so the caller (and the GraphQL pipeline)
      // gets the right exception type (e.g. NotFoundException stays a 404).
      await this.operationalErrorService.capture({
        module: 'logs-di',
        submodule: 'logsDiService',
        method: 'SET_SELECTED_COMPONENT_AS_DONE_LOGS',
        severity: 'MEDIUM',
        error: 'Failed to mark component as done in logs',
        message: (error as Error)?.message ?? String(error),
        payload: { _idDi, diIgnore, nameComponent },
      });
      throw error;
    }
  }

  async getAllLogsByDi(_idDi: string) {
    try {
      const logs = await this.logsDiModel.find({ _idDi });

      if (logs.length === 0) {
        return [];
      }
      return logs;
    } catch (error) {
      // ⚠️ The catch body was EMPTY — Mongo errors disappeared AND the
      // method returned `undefined` to callers expecting an array,
      // crashing downstream with "cannot read length of undefined".
      // Now we capture + return [] so downstream stays safe.
      await this.operationalErrorService.capture({
        module: 'logs-di',
        submodule: 'logsDiService',
        method: 'GET_ALL_LOGS_BY_DI',
        severity: 'HIGH',
        error: 'Query failed (was previously swallowed by empty catch)',
        message: (error as Error)?.message ?? String(error),
        payload: { _idDi },
      });
      return [];
    }
  }

  findAll() {
    return `This action returns all logsDi`;
  }

  findOne(id: number) {
    return `This action returns a #${id} logsDi`;
  }

  update(id: number, updateLogsDiInput: UpdateLogsDiInput) {
    return `This action updates a #${id} logsDi`;
  }

  remove(id: number) {
    return `This action removes a #${id} logsDi`;
  }
}
