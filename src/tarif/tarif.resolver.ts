import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { TarifService } from './tarif.service';
import { Tarif } from './entities/tarif.entity';
import { CreateTarifInput } from './dto/create-tarif.input';

@Resolver(() => Tarif)
export class TarifResolver {
  constructor(private readonly tarifService: TarifService) {}
  @Mutation(() => Tarif)
  createTarif(@Args('createTarifInput') createTarifInput: CreateTarifInput) {
    return this.tarifService.create(createTarifInput);
  }
  @Query(() => Tarif)
  getTarif() {
    return this.tarifService.getTarif();
  }
}
