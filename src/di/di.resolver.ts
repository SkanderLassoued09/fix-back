import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { DiService } from './di.service';
import { Di } from './entities/di.entity';
import { CreateDiInput } from './dto/create-di.input';

@Resolver(() => Di)
export class DiResolver {
  constructor(private readonly diService: DiService) {}

  @Mutation(() => Di)
  createDi(
    @Args('createDiInput')
    createDiInput: CreateDiInput,
  ) {
    return this.diService.createDi(createDiInput);
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
