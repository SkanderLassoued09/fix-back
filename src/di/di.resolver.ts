import { Resolver, Mutation, Args, Query } from '@nestjs/graphql';
import { DiService } from './di.service';
import { Di, DiTableData } from './entities/di.entity';
import { CreateDiInput, PaginationConfigDi } from './dto/create-di.input';

@Resolver(() => Di)
export class DiResolver {
  constructor(private readonly diService: DiService) {}

  @Mutation(() => Di)
  createDi(@Args('createDiInput') createDiInput: CreateDiInput) {
    return this.diService.create(createDiInput);
  }

  @Query(() => DiTableData)
  async getAllDi(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
  ) {
    console.log('🍦[paginationConfig]:', paginationConfig);
    return await this.diService.getAllDi(paginationConfig);
  }

  @Query(() => DiTableData)
  async get_coordinatorDI(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
  ) {
    console.log('🍦[paginationConfig]:', paginationConfig);
    return await this.diService.get_coordinatorDI(paginationConfig);
  }
  @Query(() => DiTableData)
  async getDiForMagasin(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
  ) {
    console.log('🍦[paginationConfig]:', paginationConfig);
    return await this.diService.getDiForMagasin(paginationConfig);
  }

  @Mutation(() => Di)
  manager_Pending1(@Args('_id') _id: string) {
    return this.diService.manager_Pending1(_id);
  }

  @Mutation(() => Di)
  magasinTech_Pending2(@Args('_id') _id: string) {
    return this.diService.magasinTech_Pending2(_id);
  }

  @Mutation(() => Di)
  managerAdminManager_Pending3(@Args('_id') _id: string) {
    return this.diService.managerAdminManager_Pending3(_id);
  }
}
