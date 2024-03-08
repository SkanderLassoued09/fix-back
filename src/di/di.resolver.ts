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
}
