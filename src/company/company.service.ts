import { Injectable } from '@nestjs/common';
import {
  CreateCompanyInput,
  PaginationConfig,
  UpdateCompanyInput,
} from './dto/create-company.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Company, CompanyTableData } from './entities/company.entity';
import { v4 as uuidv4 } from 'uuid';
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
      indexCompany = +lastCompany._id.substring(1);
      return indexCompany + 1;
    }
    return indexCompany;
  }

  async createcompany(
    createCompanyInput: CreateCompanyInput,
  ): Promise<Company> {
    const index = await this.generateCompanyId();
    createCompanyInput._id = uuidv4(); //Societe
    return await new this.CompanyModel(createCompanyInput)
      .save()
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }
  /**
 * 
it should be soft delete ya nezih change it 
 */
  async removeCompany(_id: string): Promise<Company> {
    return this.CompanyModel.findOneAndUpdate(
      { _id },
      { $set: { isDeleted: true } },
    );
  }

  async findAllCompanys(
    paginationConfig: PaginationConfig,
  ): Promise<CompanyTableData> {
    const { first, rows } = paginationConfig;

    const companyRecords = await this.CompanyModel.find({})
      .limit(rows)
      .skip(first)
      .exec();
    const totalCompanyRecord = await this.CompanyModel.countDocuments().exec();
    return { companyRecords, totalCompanyRecord };
  }

  async searchCompany(
    paginationConfig: PaginationConfig,
    search: { field: string; value: string },
  ): Promise<CompanyTableData> {
    const { first, rows } = paginationConfig;
    const { field, value } = search;

    // Base filter
    const filter: any = {};

    // Only apply search if value has 2+ characters
    if (field && value && value.trim().length >= 2) {
      const trimmedValue = value.trim();
      const regex = { $regex: `${trimmedValue}`, $options: 'i' };

      switch (field) {
        case 'name':
        case 'region':
        case 'address':
        case 'email':
        case 'raisonSociale':
        case 'exoneration':
        case 'fax':
        case 'activitePrincipale':
        case 'activiteSecondaire':
        case 'webSiteLink':
          filter[field] = regex;
          break;

        // Search in nested service objects
        case 'serviceAchat':
          filter.$or = [
            { 'serviceAchat.name': regex },
            { 'serviceAchat.email': regex },
            { 'serviceAchat.phone': regex },
          ];
          break;

        case 'serviceFinancier':
          filter.$or = [
            { 'serviceFinancier.name': regex },
            { 'serviceFinancier.email': regex },
            { 'serviceFinancier.phone': regex },
          ];
          break;

        case 'serviceTechnique':
          filter.$or = [
            { 'serviceTechnique.name': regex },
            { 'serviceTechnique.email': regex },
            { 'serviceTechnique.phone': regex },
          ];
          break;
      }
    }

    // COUNT
    const totalCompanyRecord = await this.CompanyModel.countDocuments(filter);

    // FETCH
    const companyRecords = await this.CompanyModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();

    return { companyRecords, totalCompanyRecord };
  }

  async getAllComapnyforDropDown() {
    return await this.CompanyModel.find({}).exec();
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

  async updateCompany(payload: UpdateCompanyInput) {
    return await this.CompanyModel.findOneAndUpdate(
      { _id: payload._id },
      {
        $set: {
          name: payload.name,
          region: payload.region,
          address: payload.address,
          email: payload.email,
          Exoneration: payload.Exoneration,
          fax: payload.fax,
          raisonSociale: payload.raisonSociale,
          webSiteLink: payload.webSiteLink,
          rne: payload.rne,
          mf: payload.mf,
        },
      },
      { new: true },
    );
  }

  async searchCompanies(name: string): Promise<any[]> {
    if (!name || name.trim().length < 2) {
      return [];
    }

    return this.CompanyModel.find({
      company_name: { $regex: name, $options: 'i' },
      isDeleted: false,
    })
      .select('_id company_name')
      .limit(20)
      .lean();
  }
}
