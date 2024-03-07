import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { CompanysService } from './company.service';
import { Company } from './entities/company.entity';
import { CreateCompanyInput } from './dto/create-company.input';

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
  async findAllCompany(): Promise<[Company]> {
    return await this.companysService.findAllCompanys();
  }
}
