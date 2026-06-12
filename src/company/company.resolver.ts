import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { CompanysService } from './company.service';
import { Company, CompanyTableData } from './entities/company.entity';
import {
  CreateCompanyInput,
  PaginationConfig,
  UpdateCompanyInput,
} from './dto/create-company.input';
import { SearchInput } from 'src/stat/dto/create-stat.input';

// Validation hardening: inputs are validated via class-validator on the
// company InputTypes once the global ValidationPipe is active (see main.ts).
@Resolver(() => Company)
export class CompanysResolver {
  constructor(private readonly companysService: CompanysService) {}

  @Mutation(() => Company)
  async createCompany(
    @Args('createCompanyInput') createCompanyInput: CreateCompanyInput,
  ) {
    return await this.companysService.createcompany(createCompanyInput);
  }

  @Mutation(() => Company)
  removeCompany(@Args('_id') _id: string): Promise<Company> {
    // Let the service's NotFoundException propagate (NestJS maps it to a clean
    // GraphQL error). The old try/catch never caught the async rejection AND
    // would have masked a 404 as a generic 500.
    return this.companysService.removeCompany(_id);
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
  async searchCompany(
    @Args('paginationConfig') paginationConfig: PaginationConfig,
    @Args('search') search: SearchInput,
  ): Promise<CompanyTableData> {
    return await this.companysService.searchCompany(paginationConfig, search);
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
  @Query(() => [Company])
  async searchCompanies(@Args('name') name: string): Promise<Company[]> {
    return this.companysService.searchCompanies(name);
  }

  /**
   * Repair: (re)create the client's Google Drive folder when it has none.
   * Idempotent — returns the company unchanged if `driveFolderId` is already set.
   */
  @Mutation(() => Company)
  ensureClientFolder(@Args('companyId') companyId: string): Promise<Company> {
    return this.companysService.ensureClientFolder(companyId);
  }
}
