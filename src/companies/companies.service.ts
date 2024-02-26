import { Injectable } from '@nestjs/common';
import { CreateCompanieInput } from './dto/create-company.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Companie } from './entities/company.entity';

@Injectable()
export class CompaniesService {
  constructor(
    @InjectModel('Companie') private CompanieModel: Model<Companie>,
  ) {}

  async generateCompanieId(): Promise<number> {
    let indexCompanie = 0;
    const lastCompanie = await this.CompanieModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastCompanie) {
      console.log('is entered');
      indexCompanie = +lastCompanie._id.substring(1);
      console.log(indexCompanie, '== index');
      return indexCompanie + 1;
    }
    console.log(lastCompanie, 'lastCompanie');
    return indexCompanie;
  }

  async createcompanie(
    createCompanieInput: CreateCompanieInput,
  ): Promise<Companie> {
    const index = await this.generateCompanieId();
    console.log(index, 'index Companie');
    createCompanieInput._id = `S ${index}`; //Societe
    return await new this.CompanieModel(createCompanieInput)
      .save()
      .then((res) => {
        console.log(res, 'Companie');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async removeCompanie(_id: string): Promise<Boolean> {
    return this.CompanieModel.deleteOne({ _id })
      .then(() => {
        console.log('Item has been deleted', _id);
        return true;
      })
      .catch(() => {
        console.log('Errur with item', _id);
        return false;
      });
  }

  async findAllCompanies(): Promise<[Companie]> {
    return await this.CompanieModel.find({})
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async findOneCompanie(_id: string): Promise<Companie> {
    try {
      const Companie = await this.CompanieModel.findById(_id).lean();

      if (!Companie) {
        throw new Error(`Companie with ID '${_id}' not found.`);
      }
      return Companie;
    } catch (error) {
      throw error;
    }
  }
}
