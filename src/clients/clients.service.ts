import { Injectable } from '@nestjs/common';
import { CreateClientInput } from './dto/create-client.input';
import { UpdateClientInput } from './dto/update-client.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Client } from './entities/client.entity';

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
      console.log('is entered');
      indexClient = +lastClient._id.substring(1);
      console.log(indexClient, '== index');
      return indexClient + 1;
    }
    console.log(lastClient, 'lastClient');
    return indexClient;
  }

  async createClient(createClientInput: CreateClientInput): Promise<Client> {
    const index = await this.generateClientId();
    console.log(index, 'index Client');
    createClientInput._id = `C${index}`;
    return await new this.ClientModel(createClientInput)
      .save()
      .then((res) => {
        console.log(res, 'Client');
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async removeClient(_id: string): Promise<Boolean> {
    return this.ClientModel.deleteOne({ _id })
      .then(() => {
        console.log('Item has been deleted', _id);
        return true;
      })
      .catch(() => {
        console.log('Errur with item', _id);
        return false;
      });
  }

  async findAllClients(): Promise<[Client]> {
    return await this.ClientModel.find({})
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
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
}
