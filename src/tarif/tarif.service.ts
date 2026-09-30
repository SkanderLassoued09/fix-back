import { Injectable } from '@nestjs/common';
import { CreateTarifInput } from './dto/create-tarif.input';
import { InjectModel } from '@nestjs/mongoose';
import { Tarif } from './entities/tarif.entity';
import { Model } from 'mongoose';
import { withErrorContext } from '../common/error-context';

@Injectable()
export class TarifService {
  constructor(@InjectModel('Tarif') private TarifModel: Model<Tarif>) {}

  async create(createTarifInput: CreateTarifInput) {
    try {
      await this.TarifModel.deleteMany({});
      return await new this.TarifModel(createTarifInput).save();
    } catch (error) {
      throw withErrorContext(error, 'TarifService.create');
    }
  }

  getTarif() {
    try {
      return this.TarifModel.findOne({});
    } catch (error) {
      throw withErrorContext(error, 'TarifService.getTarif');
    }
  }
}
