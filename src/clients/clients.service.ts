import { Injectable, Logger } from '@nestjs/common';
import {
  CreateClientInput,
  UpdateClientInput,
} from './dto/create-client.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Client, ClientTableData } from './entities/client.entity';
import { PaginationConfig } from 'src/company/dto/create-company.input';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import { OperationalErrorService } from '../operational-error/operational-error.service';

@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(
    @InjectModel('Client') private ClientModel: Model<Client>,
    private readonly driveService: GoogleDriveService,
    private readonly opError: OperationalErrorService,
  ) {}

  /** Display name used for the client's Drive folder + file naming. */
  private clientName(client: any): string {
    return `${client?.first_name ?? ''} ${client?.last_name ?? ''}`.trim();
  }

  /**
   * Best-effort: create the client's Google Drive folder (CLIENTS/client/{name})
   * and store its id/url on the client. NEVER blocks the client flow — on
   * failure it logs and leaves `driveFolderId` null (repairable via
   * `ensureClientDriveFolder`). Idempotent: a no-op when `driveFolderId` is set.
   * Mirrors the company hook exactly.
   */
  private async attachDriveFolder(client: any): Promise<void> {
    if (!client || client.driveFolderId) return;
    try {
      const folder = await this.driveService.ensureEntityFolder(
        'client',
        this.clientName(client),
        (client as any).createdAt ?? new Date(),
      );
      client.driveFolderId = folder.id;
      client.driveFolderUrl = folder.webViewLink;
      await client.save();
      this.logger.log(
        `Linked Drive folder ${folder.id} to client ${client._id}`,
      );
    } catch (err) {
      // Misconfiguration (Drive not set up) is EXPECTED → log only, no Discord.
      // A real API/Drive failure is OPERATIONAL → notify (deduped). ids only.
      const message = (err as Error)?.message ?? String(err);
      const misconfigured =
        /GOOGLE_DRIVE_PARENT_FOLDER_ID|credentials missing/i.test(message);
      await this.opError.capture({
        module: 'clients',
        submodule: 'drive',
        method: 'ATTACH_DRIVE_FOLDER',
        severity: misconfigured ? 'LOW' : 'MEDIUM',
        error: 'Client Drive folder not created',
        message,
        notify: !misconfigured,
        payload: { clientId: client?._id },
      });
    }
  }

  /**
   * Repair path: (re)create the Drive folder for a client only when it has
   * none. The single (re)creation entry point outside `createClient`.
   */
  async ensureClientDriveFolder(clientId: string): Promise<Client> {
    const client = await this.ClientModel.findById(clientId);
    if (!client) {
      throw new Error(`Client with ID '${clientId}' not found.`);
    }
    if ((client as any).driveFolderId) return client; // idempotent
    await this.attachDriveFolder(client);
    return client;
  }

  /**
   * Force-recreate the client's Drive folder: clear the (stale) id/url then
   * re-attach. For the service-account → OAuth migration (old SA folders are
   * unreachable under the new OAuth account).
   */
  async resetClientDriveFolder(clientId: string): Promise<Client> {
    const client = await this.ClientModel.findById(clientId);
    if (!client) {
      throw new Error(`Client with ID '${clientId}' not found.`);
    }
    (client as any).driveFolderId = null;
    (client as any).driveFolderUrl = null;
    await client.save();
    await this.attachDriveFolder(client);
    return client;
  }

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
    const client = await new this.ClientModel(createClientInput).save();
    // After persistence: auto-create the client's Drive folder (best-effort —
    // never blocks creation; repairable via ensureClientDriveFolder if Drive fails).
    await this.attachDriveFolder(client);
    return client;
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
    const totalClientRecord = await this.ClientModel.countDocuments({
      isDeleted: false,
    }).exec();
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
    // Exclude soft-deleted clients so they don't appear in the new-DI dropdown.
    return await this.ClientModel.find({ isDeleted: { $ne: true } }).exec();
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
