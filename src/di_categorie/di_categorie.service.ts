import { Injectable } from '@nestjs/common';
import { CreateDiCategorieInput } from './dto/create-di_categorie.input';
import { InjectModel } from '@nestjs/mongoose';
import { DiCategorie } from './entities/di_categorie.entity';
import { Model } from 'mongoose';

@Injectable()
export class DiCategorieService {
  constructor(
    @InjectModel('DiCategorie')
    private DiCategorieModel: Model<DiCategorie>,
  ) {}

  async generateDiCategorieId(): Promise<number> {
    let indexDiCategorie = 0;
    const lastDiCategorie = await this.DiCategorieModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastDiCategorie) {
      console.log('is entered');
      indexDiCategorie = +lastDiCategorie._id.substring(1);
      console.log(indexDiCategorie, '== index');
      return indexDiCategorie + 1;
    }
    console.log(lastDiCategorie, 'lastDiCategorie');
    return indexDiCategorie;
  }

  async createDiCategorie(
    createDiCategorieInput: CreateDiCategorieInput,
  ): Promise<DiCategorie> {
    const index = await this.generateDiCategorieId();
    console.log(index, 'index DiCategorie');
    createDiCategorieInput._id = `C_DI ${index}`;
    return await new this.DiCategorieModel(createDiCategorieInput)
      .save()
      .then((res) => {
        console.log(res, 'DiCategorie');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async removeDiCategorie(_id: string): Promise<Boolean> {
    return this.DiCategorieModel.deleteOne({ _id })
      .then(() => {
        console.log('Item has been deleted', _id);
        return true;
      })
      .catch(() => {
        console.log('Errur with item', _id);
        return false;
      });
  }

  async findAllDiCategories(): Promise<[DiCategorie]> {
    return await this.DiCategorieModel.find({})
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async findOneDiCategorie(_id: string): Promise<DiCategorie> {
    try {
      const DiCategorie = await this.DiCategorieModel.findById(_id).lean();

      if (!DiCategorie) {
        throw new Error(`DiCategorie with ID '${_id}' not found.`);
      }
      return DiCategorie;
    } catch (error) {
      throw error;
    }
  }
}
