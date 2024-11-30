import { Injectable, NotFoundException } from '@nestjs/common';
import { UpdateLogsDiInput } from './dto/update-logs-di.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiLogsDocument, LogsDi } from './entities/logs-di.entity';
import { DiagUpdateLogs } from './dto/create-logs-di.input';

@Injectable()
export class LogsDiService {
  constructor(
    @InjectModel(LogsDi.name)
    private readonly logsDiModel: Model<DiLogsDocument>,
  ) {}
  async create(_id: number) {
    return await new this.logsDiModel({ _id }).save();
  }

  async getLigsById(_id: number) {
    try {
      const logsDi = await this.logsDiModel.findOne({ _id });
      if (!logsDi) {
        throw new Error(`logsDi not found for id ${_id}`);
      }

      return logsDi;
    } catch (error) {
      throw error;
    }
  }

  // async updatePricing(_id:number,price){
  //   const pricing  = await this.logsDiModel.findOneAndUpdate({_id},{$set:{price}})
  // }

  //Tech finsih diagnostic
  async tech_startDiagnostic(_idDI: number, diag: DiagUpdateLogs) {
    console.log('fired in logs');
    const result = await this.logsDiModel.findOneAndUpdate(
      { _id: _idDI },
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
  async savePricing(_id: number, price: number, final_price?: number) {
    if (!final_price) {
      console.log('update price in logs');
      return await this.logsDiModel.findOneAndUpdate(
        { _id },
        { $set: { price, final_price } },
      );
    } else {
      console.log('update price in logs');
      return await this.logsDiModel.findOneAndUpdate(
        { _id },
        { $set: { price } },
      );
    }
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
