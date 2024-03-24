import { Resolver, Mutation, Args, Query } from '@nestjs/graphql';
import { DiService } from './di.service';
import { Di, DiTableData } from './entities/di.entity';
import {
  CreateDiInput,
  DiagUpdate,
  PaginationConfigDi,
} from './dto/create-di.input';
import { User as CurrentUser } from 'src/auth/profile.decorator';
import { TokenData } from 'src/profile/dto/create-profile.input';
import { Profile } from 'src/profile/entities/profile.entity';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
@Resolver(() => Di)
export class DiResolver {
  constructor(private readonly diService: DiService) {}

  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  createDi(
    @Args('createDiInput') createDiInput: CreateDiInput,
    @CurrentUser() profile: Profile,
  ) {
    createDiInput.createdBy = profile._id;
    console.log('🍯[profile._id]:', profile._id);

    return this.diService.createDi(createDiInput);
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
  @Mutation(() => Boolean)
  tech_startDiagnostic(
    @Args('_id') _id: string,
    @Args('diag') diag: DiagUpdate,
  ) {
    const isDiag = this.diService.tech_startDiagnostic(_id, diag);
    if (isDiag) {
      return true;
    } else {
      return false;
    }
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
