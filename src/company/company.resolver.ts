import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { CompanysService } from './company.service';
import { Company, CompanyTableData } from './entities/company.entity';
import {
  CreateCompanyInput,
  PaginationConfig,
  UpdateCompanyInput,
} from './dto/create-company.input';
import { SearchInput } from 'src/stat/dto/create-stat.input';
import { withErrorContext } from '../common/error-context';

// Validation hardening: inputs are validated via class-validator on the
// company InputTypes once the global ValidationPipe is active (see main.ts).
@Resolver(() => Company)
export class CompanysResolver {
  constructor(private readonly companysService: CompanysService) {}

  @Mutation(() => Company)
  async createCompany(
    @Args('createCompanyInput') createCompanyInput: CreateCompanyInput,
  ) {
    try {
      return await this.companysService.createcompany(createCompanyInput);
    } catch (error) {
      throw withErrorContext(error, 'CompanysResolver.createCompany');
    }
  }

  @Mutation(() => Company)
  async removeCompany(@Args('_id') _id: string): Promise<Company> {
    try {
      // Let the service's NotFoundException propagate (NestJS maps it to a clean
      // GraphQL error). The old try/catch never caught the async rejection AND
      // would have masked a 404 as a generic 500.
      return await this.companysService.removeCompany(_id);
    } catch (error) {
      throw withErrorContext(error, 'CompanysResolver.removeCompany');
    }
  }

  @Query(() => Company)
  async findOneCompany(@Args('_id') _id: string): Promise<Company> {
    try {
      return await this.companysService.findOneCompany(_id);
    } catch (error) {
      throw withErrorContext(error, 'CompanysResolver.findOneCompany');
    }
  }

  @Query(() => [Company])
  async getAllComapnyforDropDown(): Promise<any> {
    try {
      return await this.companysService.getAllComapnyforDropDown();
    } catch (error) {
      throw withErrorContext(
        error,
        'CompanysResolver.getAllComapnyforDropDown',
      );
    }
  }
  @Query(() => CompanyTableData)
  async searchCompany(
    @Args('paginationConfig') paginationConfig: PaginationConfig,
    @Args('search') search: SearchInput,
  ): Promise<CompanyTableData> {
    try {
      return await this.companysService.searchCompany(paginationConfig, search);
    } catch (error) {
      throw withErrorContext(error, 'CompanysResolver.searchCompany');
    }
  }

  @Query(() => CompanyTableData)
  async findAllCompany(
    @Args('PaginationConfig') paginationConfig: PaginationConfig,
  ): Promise<CompanyTableData> {
    try {
      return await this.companysService.findAllCompanys(paginationConfig);
    } catch (error) {
      throw withErrorContext(error, 'CompanysResolver.findAllCompany');
    }
  }

  @Mutation(() => Company)
  async updateCompany(
    @Args('updateCompanyInput') updateCompanyInput: UpdateCompanyInput,
  ) {
    try {
      return await this.companysService.updateCompany(updateCompanyInput);
    } catch (error) {
      throw withErrorContext(error, 'CompanysResolver.updateCompany');
    }
  }
  @Query(() => [Company])
  async searchCompanies(@Args('name') name: string): Promise<Company[]> {
    try {
      return await this.companysService.searchCompanies(name);
    } catch (error) {
      throw withErrorContext(error, 'CompanysResolver.searchCompanies');
    }
  }

  /**
   * Repair: (re)create the client's Google Drive folder when it has none.
   * Idempotent — returns the company unchanged if `driveFolderId` is already set.
   */
  @Mutation(() => Company)
  async ensureClientFolder(
    @Args('companyId') companyId: string,
  ): Promise<Company> {
    try {
      return await this.companysService.ensureClientFolder(companyId);
    } catch (error) {
      throw withErrorContext(error, 'CompanysResolver.ensureClientFolder');
    }
  }

  /** Force-recreate a company's Drive folder (clears the stale id then recreates
   *  under the current OAuth account). For the SA→OAuth migration. */
  @Mutation(() => Company)
  async resetCompanyDriveFolder(
    @Args('companyId') companyId: string,
  ): Promise<Company> {
    try {
      return await this.companysService.resetDriveFolder(companyId);
    } catch (error) {
      throw withErrorContext(error, 'CompanysResolver.resetCompanyDriveFolder');
    }
  }
}
