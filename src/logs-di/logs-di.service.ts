import { Injectable, NotFoundException } from '@nestjs/common';
import { UpdateLogsDiInput } from './dto/update-logs-di.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiLogsDocument, LogsDi } from './entities/logs-di.entity';
import { DiagUpdateLogs } from './dto/create-logs-di.input';
import { getFileExtension } from 'src/di/shared.files';
import * as randomstring from 'randomstring';
import { join } from 'path';
import * as fs from 'fs';
import {
  Composant,
  ComposantDocument,
} from 'src/composant/entities/composant.entity';
@Injectable()
export class LogsDiService {
  constructor(
    @InjectModel(LogsDi.name)
    private readonly logsDiModel: Model<DiLogsDocument>,
    @InjectModel(Composant.name)
    private composantModel: Model<ComposantDocument>,
  ) {}
  async create(_id: number, _idDi: string) {
    return await new this.logsDiModel({ _id, _idDi }).save();
  }

  async getLogsById(_idLog: number, _idDi: string) {
    try {
      const logsDi = await this.logsDiModel.findOne({ _id: _idLog, _idDi });
      // if (!logsDi) {
      //   throw new Error(`logsDi not found for id ${_idLog}`);
      // }

      return logsDi;
    } catch (error) {
      throw error;
    }
  }

  // async updatePricing(_id:number,price){
  //   const pricing  = await this.logsDiModel.findOneAndUpdate({_id},{$set:{price}})
  // }

  //Tech finsih diagnostic
  async tech_startDiagnostic(_id: number, _idDi: string, diag: DiagUpdateLogs) {
    console.log('fired in logs');
    const result = await this.logsDiModel.findOneAndUpdate(
      { _id, _idDi },
      {
        $set: {
          can_be_repaired: diag.can_be_repaired,
          contain_pdr: diag.contain_pdr,
          remarque_tech_diagnostic: diag.remarque_tech_diagnostic,
          array_composants: diag.array_composants,
          di_category_id: diag.di_category_id,
        },
      },
    );
    if (!result) {
      throw new Error('Issue when saving data when tech save logs');
    }

    return result;
  }
  async savePricing(
    _id: number,
    _idDi: string,
    price: number,
    final_price?: number,
  ) {
    if (!final_price) {
      console.log('update price in logs');
      return await this.logsDiModel.findOneAndUpdate(
        { _id, _idDi },
        { $set: { price, final_price } },
      );
    } else {
      console.log('update price in logs');
      return await this.logsDiModel.findOneAndUpdate(
        { _id, _idDi },
        { $set: { price } },
      );
    }
  }

  async addDevisPDFLogs(_id: number, _idDi: string, pdf: string) {
    return await this.logsDiModel.findOneAndUpdate(
      { _id, _idDi },
      { $set: { devis: pdf } },
      { new: true },
    );
  }
  async addBCPDFLogs(_id: number, _idDi: string, pdf: string) {
    return await this.logsDiModel.findOneAndUpdate(
      { _id, _idDi },
      { $set: { bon_de_commande: pdf } },
      { new: true },
    );
  }

  async calculateticketComposantPriceLogs(_id: number, _idDi: string) {
    console.log('calculateticketComposantPriceLogs');
    const ticket = await this.logsDiModel.findOne({ _id, _idDi });

    const totalPrice = await Promise.all(
      ticket.array_composants.map(async (item) => {
        const composant = await this.composantModel.findOne({
          name: item.nameComposant,
        });
        return composant ? composant.prix_vente * item.quantity : 0;
      }),
    );
    // TODO substruct the quantity needed from compsant in stock
    console.log('🍇[totalPrice in logs]:', totalPrice);
    return totalPrice.reduce((acc, curr) => acc + curr, 0);
  }

  async isSentToCoordinator(_id: number, _idDi: string) {
    console.log('retour send to confirm');
    return await this.logsDiModel.findOneAndUpdate(
      { _id, _idDi },
      { $set: { isSentToCoordinator: true } },
      { new: true },
    );
  }
  async componentConfirmedFromCoordinator(_id: number, _idDi: string) {
    return await this.logsDiModel.findOneAndUpdate(
      { _id, _idDi },
      {
        $set: {
          isConfirmedComponentFromCoordinator: true,
        },
      },
    );
  }
  async setSelectedComponentAsDoneLogs(_id: number, nameComponent: string) {
    console.log('🌰[nameComponent]:', nameComponent);

    // Find the document with the specific component
    const updatedDocument = await this.logsDiModel.findOneAndUpdate(
      { _id, 'array_composants.nameComposant': nameComponent },
      { $set: { 'array_composants.$.isUpdated': true } }, // Update only the matched component
      { new: true }, // Return the updated document
    );

    if (!updatedDocument) {
      throw new NotFoundException(`Document or component not found.`);
    }

    return updatedDocument;
  }

  // NEZIH ya m9a7eb
  async getAllLogsByDi(_id: string) {
    try {
      const logs = await this.logsDiModel.find({ _id });
      if (logs.length === 0) {
        throw new Error('No logs for this DI');
      } else {
        return logs;
      }
    } catch (error) {
      throw error;
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
