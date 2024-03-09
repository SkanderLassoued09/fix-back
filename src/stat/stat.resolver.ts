import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { StatService } from './stat.service';
import { Stat } from './entities/stat.entity';
import { CreateStatInput } from './dto/create-stat.input';
import { UpdateStatInput } from './dto/update-stat.input';
import { User as CurrentUser } from 'src/auth/profile.decorator';
import { Profile } from 'src/profile/entities/profile.entity';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';

@Resolver(() => Stat)
export class StatResolver {
  constructor(private readonly statService: StatService) {}

  @Mutation(() => Stat)
  createStat(@Args('createStatInput') createStatInput: CreateStatInput) {
    return this.statService.createStat(createStatInput);
  }

  @Mutation(() => Boolean)
  affectForDiag(
    @Args('_idDi') _idDi: string,
    @Args('_idTech') _idTech: string,
  ) {
    const isAffected = this.statService.affectForDiag(_idDi, _idTech);
    if (isAffected) {
      return true;
    } else {
      false;
    }
  }

  @Query(() => [Stat])
  @UseGuards(JwtAuthGuard)
  getDiForTech(@CurrentUser() tech: Profile) {
    return this.statService.getDiForTech(tech._id);
  }
}
