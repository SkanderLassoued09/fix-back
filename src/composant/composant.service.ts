import { Injectable } from '@nestjs/common';
import { CreateComposantInput } from './dto/create-composant.input';
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
      indexComposant = +lastComposant._id.substring(1);
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
    createComposantInput._id = `Cmp ${index}`;
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

  async findOneComposant(_id: string): Promise<Composant> {
    try {
      const Composant = await this.ComposantModel.findById(_id).lean();

      if (!Composant) {
        throw new Error(`Composant with ID '${_id}' not found.`);
      }
      return Composant;
    } catch (error) {
      throw error;
    }
  }
}
