import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { CompanysService } from './company.service';
import { Company, CompanyTableData } from './entities/company.entity';
import {
  CreateCompanyInput,
  PaginationConfig,
  UpdateCompanyInput,
} from './dto/create-company.input';

@Resolver(() => Company)
export class CompanysResolver {
  constructor(private readonly companysService: CompanysService) {}

  @Mutation(() => Company)
  async createCompany(
    @Args('createCompanyInput') createCompanyInput: CreateCompanyInput,
  ) {
    return await this.companysService.createcompany(createCompanyInput);
  }

  @Mutation(() => Boolean)
  removeCompany(@Args('_id') _id: string): Promise<Boolean> {
    try {
      return this.companysService.removeCompany(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete Company');
    }
  }

  @Query(() => Company)
  async findOneCompany(@Args('_id') _id: string): Promise<Company> {
    return await this.companysService.findOneCompany(_id);
  }

  @Query(() => [Company])
  async getAllComapnyforDropDown(): Promise<any> {
    return await this.companysService.getAllComapnyforDropDown();
  }

  @Query(() => CompanyTableData)
  async findAllCompany(
    @Args('PaginationConfig') paginationConfig: PaginationConfig,
  ): Promise<CompanyTableData> {
    return await this.companysService.findAllCompanys(paginationConfig);
  }

  @Mutation(() => Company)
  updateCompany(
    @Args('updateCompanyInput') updateCompanyInput: UpdateCompanyInput,
  ) {
    return this.companysService.updateCompany(updateCompanyInput);
  }
}
