import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { ClientsService } from './clients.service';
import { Client, ClientTableData } from './entities/client.entity';
import {
  CreateClientInput,
  UpdateClientInput,
} from './dto/create-client.input';
import { PaginationConfig } from 'src/company/dto/create-company.input';
import { SearchInput } from 'src/stat/dto/create-stat.input';
import { withErrorContext, reportCatchError } from '../common/error-context';

@Resolver(() => Client)
export class ClientsResolver {
  constructor(private readonly clientsService: ClientsService) {}

  @Mutation(() => Client)
  async createClient(
    @Args('createClientInput')
    createClientInput: CreateClientInput,
  ) {
    try {
      return await this.clientsService.createClient(createClientInput);
    } catch (error) {
      throw withErrorContext(error, 'ClientsResolver.createClient');
    }
  }

  @Mutation(() => Client)
  removeClient(@Args('_id') _id: string): Promise<Client> {
    try {
      return this.clientsService.removeClient(_id);
    } catch (error) {
      reportCatchError(error, 'ClientsResolver.removeClient');
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
      reportCatchError(error, 'ClientsResolver.updateClient');
      console.error(error);
      throw new Error('Failed to delete Client');
    }
  }

  @Query(() => Client)
  async findOneClient(@Args('_id') _id: string): Promise<Client> {
    try {
      return await this.clientsService.findOneClient(_id);
    } catch (error) {
      throw withErrorContext(error, 'ClientsResolver.findOneClient');
    }
  }

  @Query(() => [Client])
  async getAllClient(): Promise<any> {
    try {
      return await this.clientsService.getAllClient();
    } catch (error) {
      throw withErrorContext(error, 'ClientsResolver.getAllClient');
    }
  }

  @Query(() => ClientTableData)
  async findAllClient(
    @Args('PaginationConfig') paginationConfig: PaginationConfig,
  ): Promise<ClientTableData> {
    try {
      return await this.clientsService.findAllClients(paginationConfig);
    } catch (error) {
      throw withErrorContext(error, 'ClientsResolver.findAllClient');
    }
  }
  @Query(() => ClientTableData)
  async searchClient(
    @Args('paginationConfig') paginationConfig: PaginationConfig,
    @Args('search') search: SearchInput,
  ): Promise<ClientTableData> {
    try {
      return await this.clientsService.searchClient(paginationConfig, search);
    } catch (error) {
      throw withErrorContext(error, 'ClientsResolver.searchClient');
    }
  }

  /** (Re)create the client's Drive folder when it has none. Idempotent. */
  @Mutation(() => Client)
  async ensureClientDriveFolder(
    @Args('clientId') clientId: string,
  ): Promise<Client> {
    try {
      return await this.clientsService.ensureClientDriveFolder(clientId);
    } catch (error) {
      throw withErrorContext(error, 'ClientsResolver.ensureClientDriveFolder');
    }
  }

  /** Force-recreate a client's Drive folder (clears the stale id then recreates
   *  under the current OAuth account). For the SA→OAuth migration. */
  @Mutation(() => Client)
  async resetClientDriveFolder(
    @Args('clientId') clientId: string,
  ): Promise<Client> {
    try {
      return await this.clientsService.resetClientDriveFolder(clientId);
    } catch (error) {
      throw withErrorContext(error, 'ClientsResolver.resetClientDriveFolder');
    }
  }
}
