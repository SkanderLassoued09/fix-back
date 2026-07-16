import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CreateDiCategoryInput } from './dto/create-di_category.input';
import { InjectModel } from '@nestjs/mongoose';
import { DiCategory } from './entities/di_category.entity';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
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
    const normalizedCategory = category?.trim();
    if (!normalizedCategory) {
      throw new InternalServerErrorException('Category name is required');
    }
    const escapedCategory = normalizedCategory.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    const existing = await this.DiCategoryModel.findOne({
      category: { $regex: `^${escapedCategory}$`, $options: 'i' },
      isDeleted: false,
    });

    if (existing) {
      return existing;
    }

    const index = await this.generateDiId();
    let dataCategory = {} as CreateDiCategoryInput;
    dataCategory._id = uuidv4();
    dataCategory.category = normalizedCategory;

    const result = await new this.DiCategoryModel(dataCategory).save();
    return result;
  }

  // remove
  async removeDiCategory(_id: string): Promise<DiCategory> {
    return await this.DiCategoryModel.findOneAndUpdate(
      { _id },
      { $set: { isDeleted: true } },
      { new: true },
    );
  }

  async findAllDiCategorys(): Promise<DiCategory[]> {
    try {
      const categories = await this.DiCategoryModel.find({
        isDeleted: false,
      }).sort({ createdAt: -1 });
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
      const DiCategory = await this.DiCategoryModel.findOne({
        _id,
        isDeleted: false,
      });

      if (!DiCategory) {
        throw new Error(`DiCategory with ID '${_id}' not found.`);
      }
      return DiCategory;
    } catch (error) {
      throw error;
    }
  }
}
