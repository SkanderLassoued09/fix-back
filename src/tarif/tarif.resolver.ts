import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { TarifService } from './tarif.service';
import { Tarif } from './entities/tarif.entity';
import { CreateTarifInput } from './dto/create-tarif.input';
import { withErrorContext } from '../common/error-context';

@Resolver(() => Tarif)
export class TarifResolver {
  constructor(private readonly tarifService: TarifService) {}
  @Mutation(() => Tarif)
  async createTarif(
    @Args('createTarifInput') createTarifInput: CreateTarifInput,
  ) {
    try {
      return await this.tarifService.create(createTarifInput);
    } catch (error) {
      throw withErrorContext(error, 'TarifResolver.createTarif');
    }
  }
  @Query(() => Tarif, { nullable: true })
  getTarif() {
    try {
      return this.tarifService.getTarif();
    } catch (error) {
      throw withErrorContext(error, 'TarifResolver.getTarif');
    }
  }
}
