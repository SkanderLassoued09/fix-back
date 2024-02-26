import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Composant_Categorie } from './entities/composant_categorie.entity';
import { CreateComposant_CategorieInput } from './dto/create-composant_categorie.input';

@Injectable()
export class Composant_CategorieService {
  constructor(
    @InjectModel('Composant_Categorie')
    private Composant_CategorieModel: Model<Composant_Categorie>,
  ) {}

  async generateComposant_CategorieId(): Promise<number> {
    let indexComposant_Categorie = 0;
    const lastComposant_Categorie = await this.Composant_CategorieModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastComposant_Categorie) {
      console.log('is entered');
      indexComposant_Categorie = +lastComposant_Categorie._id.substring(1);
      console.log(indexComposant_Categorie, '== index');
      return indexComposant_Categorie + 1;
    }
    console.log(lastComposant_Categorie, 'lastComposant_Categorie');
    return indexComposant_Categorie;
  }

  async createComposant_Categorie(
    createComposant_CategorieInput: CreateComposant_CategorieInput,
  ): Promise<Composant_Categorie> {
    const index = await this.generateComposant_CategorieId();
    console.log(index, 'index Composant_Categorie');
    createComposant_CategorieInput._id = `C_Composant ${index}`;
    return await new this.Composant_CategorieModel(
      createComposant_CategorieInput,
    )
      .save()
      .then((res) => {
        console.log(res, 'Composant_Categorie');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async removeComposant_Categorie(_id: string): Promise<Boolean> {
    return this.Composant_CategorieModel.deleteOne({ _id })
      .then(() => {
        console.log('Item has been deleted', _id);
        return true;
      })
      .catch(() => {
        console.log('Errur with item', _id);
        return false;
      });
  }

  async findAllComposant_Categories(): Promise<[Composant_Categorie]> {
    return await this.Composant_CategorieModel.find({})
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async findOneComposant_Categorie(_id: string): Promise<Composant_Categorie> {
    try {
      const Composant_Categorie = await this.Composant_CategorieModel.findById(
        _id,
      ).lean();

      if (!Composant_Categorie) {
        throw new Error(`Composant_Categorie with ID '${_id}' not found.`);
      }
      return Composant_Categorie;
    } catch (error) {
      throw error;
    }
  }
}
