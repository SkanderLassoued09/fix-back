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

  async generateDiCategoryId(): Promise<number> {
    let indexDiCategory = 0;
    const lastDiCategory = await this.DiCategoryModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastDiCategory) {
      console.log('is entered');
      indexDiCategory = +lastDiCategory._id.substring(1);
      console.log(indexDiCategory, '== index');
      return indexDiCategory + 1;
    }
    console.log(lastDiCategory, 'lastDiCategory');
    return indexDiCategory;
  }

  async createDiCategory(
    createDiCategoryInput: CreateDiCategoryInput,
  ): Promise<DiCategory> {
    const index = await this.generateDiCategoryId();
    console.log(index, 'index DiCategory');
    createDiCategoryInput._id = `C_DI ${index}`;
    return await new this.DiCategoryModel(createDiCategoryInput)
      .save()
      .then((res) => {
        console.log(res, 'DiCategory');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

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
