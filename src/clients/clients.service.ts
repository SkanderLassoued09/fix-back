import { Injectable } from '@nestjs/common';
import {
  CreateClientInput,
  UpdateClientInput,
} from './dto/create-client.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Client, ClientTableData } from './entities/client.entity';
import { PaginationConfig } from 'src/company/dto/create-company.input';

@Injectable()
export class ClientsService {
  constructor(@InjectModel('Client') private ClientModel: Model<Client>) {}

  async generateClientId(): Promise<number> {
    let indexClient = 0;
    const lastClient = await this.ClientModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastClient) {
      indexClient = +lastClient._id.substring(1);
      return indexClient + 1;
    }
    return indexClient;
  }

  async createClient(createClientInput: CreateClientInput): Promise<Client> {
    const index = await this.generateClientId();
    createClientInput._id = `C${index}`;
    return await new this.ClientModel(createClientInput)
      .save()
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async removeClient(_id: string): Promise<Client> {
    return await this.ClientModel.findOneAndUpdate(
      { _id },
      { $set: { isDeleted: true } },
      { new: true },
    );
  }

  async searchClient(
    paginationConfig: PaginationConfig,
    search: { field: string; value: string },
  ): Promise<ClientTableData> {
    const { first, rows } = paginationConfig;
    const { field, value } = search;

    // Base filter
    const filter: any = { isDeleted: false };

    // Only apply search if value has 2+ characters
    if (field && value && value.trim().length >= 2) {
      const trimmedValue = value.trim();
      const regex = { $regex: `${trimmedValue}`, $options: 'i' };

      switch (field) {
        case 'first_name':
        case 'last_name':
        case 'email':
        case 'region':
        case 'phone':
        case 'address':
          filter[field] = regex;
          break;
      }
    }

    console.log('🔍[Client Search Filter]:', JSON.stringify(filter, null, 2));

    // COUNT
    const totalClientRecord = await this.ClientModel.countDocuments(filter);

    // FETCH
    const clientRecords = await this.ClientModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();

    return { clientRecords, totalClientRecord };
  }

  async findAllClients(
    paginationConfig: PaginationConfig,
  ): Promise<ClientTableData> {
    const { first, rows } = paginationConfig;
    const clientRecords = await this.ClientModel.find({ isDeleted: false })
      .limit(rows)
      .skip(first)
      .exec();
    const totalClientRecord = await this.ClientModel.countDocuments().exec();
    return { clientRecords, totalClientRecord };
  }

  async findOneClient(_id: string): Promise<Client> {
    try {
      const Client = await this.ClientModel.findById(_id).lean();

      if (!Client) {
        throw new Error(`Client with ID '${_id}' not found.`);
      }
      return Client;
    } catch (error) {
      throw error;
    }
  }

  async getAllClient() {
    return await this.ClientModel.find({}).exec();
  }

  async updateClient(payload: UpdateClientInput) {
    const result = await this.ClientModel.findOneAndUpdate(
      { _id: payload._id },
      {
        $set: {
          first_name: payload.first_name,
          last_name: payload.last_name,
          region: payload.region,
          address: payload.address,
          email: payload.email,
          phone: payload.phone,
        },
      },
      { new: true },
    );

    if (!result) {
      console.error('error while updating client', result);
    }

    return result;
  }
}
