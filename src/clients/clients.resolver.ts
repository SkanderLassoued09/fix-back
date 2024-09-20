import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { ClientsService } from './clients.service';
import { Client, ClientTableData } from './entities/client.entity';
import {
  CreateClientInput,
  UpdateClientInput,
} from './dto/create-client.input';
import { PaginationConfig } from 'src/company/dto/create-company.input';

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

  @Mutation(() => Client)
  updateClient(
    @Args('updateClientInput') updateClientInput: UpdateClientInput,
  ): Promise<Client> {
    try {
      return this.clientsService.updateClient(updateClientInput);
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
  async getAllClient(): Promise<any> {
    return await this.clientsService.getAllClient();
  }

  @Query(() => ClientTableData)
  async findAllClient(
    @Args('PaginationConfig') paginationConfig: PaginationConfig,
  ): Promise<ClientTableData> {
    return await this.clientsService.findAllClients(paginationConfig);
  }
}
