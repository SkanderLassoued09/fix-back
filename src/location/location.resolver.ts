import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { Location } from './entities/location.entity';
import { CreateLocationInput } from './dto/create-location.input';
import { LocationService } from './location.service';

@Resolver(() => Location)
export class LocationResolver {
  constructor(private readonly locationService: LocationService) {}

  @Mutation(() => Location)
  createLocation(
    @Args('createLocationInput')
    createLocationInput: CreateLocationInput,
  ) {
    return this.locationService.createlocation(createLocationInput);
  }

  @Mutation(() => Boolean)
  removeLocation(@Args('_id') _id: string): Promise<Boolean> {
    try {
      return this.locationService.removeLocation(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete Location');
    }
  }

  @Query(() => Location)
  async findOneLocation(@Args('_id') _id: string): Promise<Location> {
    return await this.locationService.findOneLocation(_id);
  }

  @Query(() => [Location])
  async findAllLocation(): Promise<[Location]> {
    return await this.locationService.findAllLocations();
  }
}
