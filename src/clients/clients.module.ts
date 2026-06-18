import { Module } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { ClientsResolver } from './clients.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { ClientSchema } from './entities/client.entity';
import { GoogleDriveModule } from '../google-drive/google-drive.module';
import { OperationalErrorModule } from '../operational-error/operational-error.module';

@Module({
  providers: [ClientsResolver, ClientsService],
  imports: [
    GoogleDriveModule,
    OperationalErrorModule,
    MongooseModule.forFeature([
      {
        name: 'Client',
        schema: ClientSchema,
      },
    ]),
  ],
  exports: [ClientsService],
})
export class ClientsModule {}
