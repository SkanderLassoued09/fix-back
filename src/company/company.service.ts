import { Injectable } from '@nestjs/common';
import { CreateCompanyInput } from './dto/create-company.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Company } from './entities/company.entity';

@Injectable()
export class CompanysService {
  constructor(@InjectModel('Company') private CompanyModel: Model<Company>) {}

  async generateCompanyId(): Promise<number> {
    let indexCompany = 0;
    const lastCompany = await this.CompanyModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastCompany) {
      console.log('is entered');
      indexCompany = +lastCompany._id.substring(1);
      console.log(indexCompany, '== index');
      return indexCompany + 1;
    }
    console.log(lastCompany, 'lastCompany');
    return indexCompany;
  }

  async createcompany(
    createCompanyInput: CreateCompanyInput,
  ): Promise<Company> {
    const index = await this.generateCompanyId();
    console.log(index, 'index Company');
    createCompanyInput._id = `S ${index}`; //Societe
    return await new this.CompanyModel(createCompanyInput)
      .save()
      .then((res) => {
        console.log(res, 'Company');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async removeCompany(_id: string): Promise<Boolean> {
    return this.CompanyModel.deleteOne({ _id })
      .then(() => {
        console.log('Item has been deleted', _id);
        return true;
      })
      .catch(() => {
        console.log('Errur with item', _id);
        return false;
      });
  }

  async findAllCompanys(): Promise<[Company]> {
    return await this.CompanyModel.find({})
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async findOneCompany(_id: string): Promise<Company> {
    try {
      const Company = await this.CompanyModel.findById(_id).lean();

      if (!Company) {
        throw new Error(`Company with ID '${_id}' not found.`);
      }
      return Company;
    } catch (error) {
      throw error;
    }
  }
}
