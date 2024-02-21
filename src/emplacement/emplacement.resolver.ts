import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { EmplacementService } from './emplacement.service';
import { Emplacement } from './entities/emplacement.entity';
import { CreateEmplacementInput } from './dto/create-emplacement.input';
import { UpdateEmplacementInput } from './dto/update-emplacement.input';

@Resolver(() => Emplacement)
export class EmplacementResolver {
  constructor(private readonly emplacementService: EmplacementService) {}

  @Mutation(() => Emplacement)
  createEmplacement(
    @Args('createEmplacementInput')
    createEmplacementInput: CreateEmplacementInput,
  ) {
    return this.emplacementService.createEmplacement(createEmplacementInput);
  }
}
