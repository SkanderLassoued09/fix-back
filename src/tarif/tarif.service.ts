import { Injectable } from '@nestjs/common';
import { CreateTarifInput } from './dto/create-tarif.input';
import { InjectModel } from '@nestjs/mongoose';
import { Tarif } from './entities/tarif.entity';
import { Model } from 'mongoose';

@Injectable()
export class TarifService {
  constructor(@InjectModel('Tarif') private TarifModel: Model<Tarif>) {}

  async create(createTarifInput: CreateTarifInput) {
    await this.TarifModel.deleteMany({});
    return await new this.TarifModel(createTarifInput).save();
  }

  getTarif() {
    return this.TarifModel.find({});
  }
}
