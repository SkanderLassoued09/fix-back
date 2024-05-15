import { Module } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { ClientsResolver } from './clients.resolver';
import { MongooseModule } from '@nestjs/mongoose';
import { ClientSchema } from './entities/client.entity';

@Module({
  providers: [ClientsResolver, ClientsService],
  imports: [
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
