import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
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

    const result = await new this.DiCategoryModel(dataCategory).save();
    return result;
  }

  // remove
  async removeDiCategory(_id: string): Promise<Boolean> {
    return this.DiCategoryModel.deleteOne({ _id })
      .then(() => {
        return true;
      })
      .catch(() => {
        return false;
      });
  }

  async findAllDiCategorys(): Promise<DiCategory[]> {
    try {
      const categories = await this.DiCategoryModel.find({});
      if (categories.length === 0) {
        throw new NotFoundException('Unable to find catorgories');
      }
      return categories;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException('Unable to find categories');
    }
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
