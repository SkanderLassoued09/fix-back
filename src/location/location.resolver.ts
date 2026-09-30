import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { Location } from './entities/location.entity';
import { CreateLocationInput } from './dto/create-location.input';
import { LocationService } from './location.service';
import { withErrorContext } from '../common/error-context';

@Resolver(() => Location)
export class LocationResolver {
  constructor(private readonly locationService: LocationService) {}

  @Mutation(() => Location)
  async createLocation(
    @Args('createLocationInput')
    createLocationInput: CreateLocationInput,
  ) {
    try {
      return await this.locationService.createlocation(createLocationInput);
    } catch (error) {
      throw withErrorContext(error, 'LocationResolver.createLocation');
    }
  }

  @Mutation(() => Location)
  removeLocation(@Args('_id') _id: string): Promise<Location> {
    try {
      return this.locationService.removeLocation(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete Location');
    }
  }

  @Query(() => Location)
  async findOneLocation(@Args('_id') _id: string): Promise<Location> {
    try {
      return await this.locationService.findOneLocation(_id);
    } catch (error) {
      throw withErrorContext(error, 'LocationResolver.findOneLocation');
    }
  }

  @Query(() => [Location])
  async findAllLocation(): Promise<Location[]> {
    try {
      return await this.locationService.findAllLocations();
    } catch (error) {
      throw withErrorContext(error, 'LocationResolver.findAllLocation');
    }
  }
}
