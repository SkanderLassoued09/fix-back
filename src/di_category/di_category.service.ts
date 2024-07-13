import { Injectable } from '@nestjs/common';
import { CreateDiCategoryInput } from './dto/create-di_category.input';
import { InjectModel } from '@nestjs/mongoose';
import { DiCategory } from './entities/di_category.entity';
import { Model } from 'mongoose';

@Injectable()
export class DiCategoryService {
  constructor(
    @InjectModel('DiCategory')
    private DiCategoryModel: Model<DiCategory>,
  ) {}

  async generateDiId(): Promise<number> {
    let indexDi = 0;
    const lastDi = await this.DiCategoryModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastDi) {
      indexDi = +lastDi._id.substring(4);

      return indexDi + 1;
    }

    return indexDi;
  }

  // create
  async createDiCategory(category: string): Promise<DiCategory> {
    const index = await this.generateDiId();
    let dataCategory = {} as CreateDiCategoryInput;
    dataCategory._id = `DI_C${index}`;
    dataCategory.category = category;

    console.log('🥚[dataCategory]:', dataCategory);

    const result = await new this.DiCategoryModel(dataCategory).save();
    console.log('🍖[result]:', result);
    return result;
  }

  // remove
  async removeDiCategory(_id: string): Promise<Boolean> {
    return this.DiCategoryModel.deleteOne({ _id })
      .then(() => {
        console.log('Item has been deleted', _id);
        return true;
      })
      .catch(() => {
        console.log('Errur with item', _id);
        return false;
      });
  }

  async findAllDiCategorys(): Promise<[DiCategory]> {
    return await this.DiCategoryModel.find({})
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async findOneDiCategory(_id: string): Promise<DiCategory> {
    try {
      const DiCategory = await this.DiCategoryModel.findById(_id).lean();

      if (!DiCategory) {
        throw new Error(`DiCategory with ID '${_id}' not found.`);
      }
      return DiCategory;
    } catch (error) {
      throw error;
    }
  }
}
