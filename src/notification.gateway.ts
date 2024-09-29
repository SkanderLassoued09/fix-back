import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({ cors: true })
export class NotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private logger: Logger = new Logger('NotificationsGateway');

  afterInit(server: Server) {
    this.logger.log('Init');
  }

  handleConnection(client: Socket, ...args: any[]) {
    // this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    // this.logger.log(`Client disconnected: ${client.id}`);
  }

  sendReminder(message: any) {
    this.server.emit('reminder', message);
  }

  sendNotificationDiag(message: any) {
    this.server.emit('sendDitoDiagnostique', message);
  }
  sendNotifcationToAdmins(message: any) {
    this.server.emit('sendNotifcationToAdmins', message);
  }
  confirmComposant(message: any) {
    this.server.emit('confirmAllComposant', message);
  }
}
