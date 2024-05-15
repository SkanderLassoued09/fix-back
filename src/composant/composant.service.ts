import { Injectable } from '@nestjs/common';
import {
  CreateComposantInput,
  UpdateComposantResponse,
} from './dto/create-composant.input';
import { InjectModel } from '@nestjs/mongoose';
import { Composant } from './entities/composant.entity';
import { Model } from 'mongoose';

@Injectable()
export class ComposantService {
  constructor(
    @InjectModel('Composant') private ComposantModel: Model<Composant>,
  ) {}

  async generateComposantId(): Promise<number> {
    let indexComposant = 0;
    const lastComposant = await this.ComposantModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastComposant) {
      console.log('is entered');
      indexComposant = +lastComposant._id.substring(3);
      console.log(indexComposant, '== index');
      return indexComposant + 1;
    }
    console.log(lastComposant, 'lastComposant');
    return indexComposant;
  }

  async createComposant(
    createComposantInput: CreateComposantInput,
  ): Promise<Composant> {
    const index = await this.generateComposantId();
    console.log(index, 'index Composant');
    createComposantInput._id = `Cmp${index}`;
    return await new this.ComposantModel(createComposantInput)
      .save()
      .then((res) => {
        console.log(res, 'Composant');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async removeComposant(_id: string): Promise<Boolean> {
    return this.ComposantModel.deleteOne({ _id })
      .then(() => {
        console.log('Item has been deleted', _id);
        return true;
      })
      .catch(() => {
        console.log('Errur with item', _id);
        return false;
      });
  }

  async findAllComposants(): Promise<[Composant]> {
    return await this.ComposantModel.find({})
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async findOneComposant(name: string): Promise<Composant> {
    return await this.ComposantModel.findOne({ name }).exec();

    //   if (!Composant) {
    //     throw new Error(`Composant with ID '${_id}' not found.`);
    //   }
    //   return Composant;
    // } catch (error) {
    //   throw error;
    // }
  }

  // this function after recieving ticket from tech
  async addComposantInfo(
    updateComposant: CreateComposantInput,
  ): Promise<UpdateComposantResponse> {
    try {
      // Perform the update operation
      await this.ComposantModel.updateOne(
        { name: updateComposant.name },
        {
          $set: {
            package: updateComposant.package,
            category_composant_id: updateComposant.category_composant_id,
            prix_achat: updateComposant.prix_achat,
            prix_vente: updateComposant.prix_vente,
            coming_date: updateComposant.coming_date,
            link: updateComposant.link,
            quantity_stocked: updateComposant.quantity_stocked,
            pdf: updateComposant.pdf,
            status: updateComposant.status,
          },
        },
      );

      const updatedEntity = await this.ComposantModel.findOne({
        name: updateComposant.name,
      });

      if (updatedEntity) {
        return updatedEntity;
      }
    } catch (error) {
      throw new Error('Failed to update composant: ' + error.message);
    }
  }
}
