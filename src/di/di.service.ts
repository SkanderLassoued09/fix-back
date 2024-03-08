import { Injectable } from '@nestjs/common';
import { CreateDiInput, PaginationConfigDi } from './dto/create-di.input';
import { InjectModel } from '@nestjs/mongoose';
import { Di, DiDocument } from './entities/di.entity';
import { Model } from 'mongoose';

@Injectable()
export class DiService {
  constructor(@InjectModel(Di.name) private diModel: Model<DiDocument>) {}
  async create(createDiInput: CreateDiInput) {
    return await new this.diModel(createDiInput).save();
  }

  async getAllDi(paginationConfig: PaginationConfigDi) {
    const { first, rows } = paginationConfig;
    const totalDiCount = await this.diModel.countDocuments().exec();
    const diRecords = await this.diModel
      .find({})
      .populate('client_id', 'first_name last_name')
      .populate('created_by_id', 'firstName lastName')
      .populate('location_id', 'location_name')
      .populate('remarque_id', 'remarque_manager')
      .populate('di_category_id', 'category_Di')

      .limit(rows)
      .skip(first)
      .exec();
    console.log('🍊[diRecords]:', diRecords);
    return { diRecords, totalDiCount };
  }
}
