import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { CompaniesService } from './companies.service';
import { Companie } from './entities/company.entity';
import { CreateCompanieInput } from './dto/create-company.input';

@Resolver(() => Companie)
export class CompaniesResolver {
  constructor(private readonly companiesService: CompaniesService) {}

  @Mutation(() => Companie)
  async createCompanie(
    @Args('createCompanieInput') createCompanieInput: CreateCompanieInput,
  ) {
    return this.companiesService.createcompanie(createCompanieInput);
  }

  @Mutation(() => Boolean)
  removeCompanie(@Args('_id') _id: string): Promise<Boolean> {
    try {
      return this.companiesService.removeCompanie(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete Companie');
    }
  }

  @Query(() => Companie)
  async findOneCompanie(@Args('_id') _id: string): Promise<Companie> {
    return await this.companiesService.findOneCompanie(_id);
  }

  @Query(() => [Companie])
  async findAllCompanie(): Promise<[Companie]> {
    return await this.companiesService.findAllCompanies();
  }
}
