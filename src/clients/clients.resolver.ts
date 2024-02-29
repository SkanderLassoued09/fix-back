import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { ClientsService } from './clients.service';
import { Client } from './entities/client.entity';
import { CreateClientInput } from './dto/create-client.input';

@Resolver(() => Client)
export class ClientsResolver {
  constructor(private readonly clientsService: ClientsService) {}

  @Mutation(() => Client)
  createClient(
    @Args('createClientInput')
    createClientInput: CreateClientInput,
  ) {
    return this.clientsService.createClient(createClientInput);
  }

  @Mutation(() => Boolean)
  removeClient(@Args('_id') _id: string): Promise<Boolean> {
    try {
      return this.clientsService.removeClient(_id);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to delete Client');
    }
  }

  @Query(() => Client)
  async findOneClient(@Args('_id') _id: string): Promise<Client> {
    return await this.clientsService.findOneClient(_id);
  }

  @Query(() => [Client])
  async findAllClient(): Promise<[Client]> {
    return await this.clientsService.findAllClients();
  }
}
