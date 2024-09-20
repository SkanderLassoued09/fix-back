import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Composant_Category } from './entities/composant_category.entity';
import { CreateComposant_CategoryInput } from './dto/create-composant_category.input';

@Injectable()
export class Composant_CategoryService {
  constructor(
    @InjectModel('Composant_Category')
    private Composant_CategoryModel: Model<Composant_Category>,
  ) {}

  async generateComposant_CategoryId(): Promise<number> {
    let indexComposant_Category = 0;
    const lastComposant_Category = await this.Composant_CategoryModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastComposant_Category) {
      indexComposant_Category = +lastComposant_Category._id.substring(1);
      return indexComposant_Category + 1;
    }
    return indexComposant_Category;
  }

  async createComposant_Category(
    createComposant_CategoryInput: CreateComposant_CategoryInput,
  ): Promise<Composant_Category> {
    const index = await this.generateComposant_CategoryId();
    createComposant_CategoryInput._id = `C_Composant ${index}`;
    return await new this.Composant_CategoryModel(createComposant_CategoryInput)
      .save()
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async removeComposant_Category(_id: string): Promise<Boolean> {
    return this.Composant_CategoryModel.deleteOne({ _id })
      .then(() => {
        return true;
      })
      .catch(() => {
        return false;
      });
  }

  async findAllComposant_Categorys(): Promise<[Composant_Category]> {
    return await this.Composant_CategoryModel.find({})
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async findOneComposant_Category(_id: string): Promise<Composant_Category> {
    try {
      const Composant_Category = await this.Composant_CategoryModel.findById(
        _id,
      ).lean();

      if (!Composant_Category) {
        throw new Error(`Composant_Category with ID '${_id}' not found.`);
      }
      return Composant_Category;
    } catch (error) {
      throw error;
    }
  }
}
