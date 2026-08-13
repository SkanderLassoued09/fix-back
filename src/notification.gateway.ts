import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';

// Même secret que `auth.module`/`jwt.strategy` (JWT partagé). La vérification
// est faite ici SANS injecter `JwtService` : la gateway est fournie par 3
// modules (di/stat/cron), un import DI supplémentaire les fragiliserait tous.
const JWT_SECRET = 'hide-me';

@WebSocketGateway({ cors: true })
export class NotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private logger: Logger = new Logger('NotificationsGateway');

  afterInit(server: Server) {
    this.logger.log('Init');
  }

  /**
   * Handshake AUTHENTIFIÉ (ADDITIF, non bloquant) : si le client fournit un
   * token (`handshake.auth.token` ou `?token=`) valide, on le joint aux rooms
   * `user:{_id}` et `role:{ROLE}` → les notifications PERSONNELLES ne partent
   * que vers ces rooms. Un client SANS token reste connecté en anonyme et
   * continue de recevoir les broadcasts existants (`updateTicket`, …) : ZÉRO
   * régression sur l'existant.
   */
  handleConnection(client: Socket) {
    const token =
      (client.handshake?.auth as any)?.token ||
      (client.handshake?.query as any)?.token;
    if (!token) return; // anonyme : broadcasts uniquement
    try {
      const decoded: any = jwt.verify(String(token), JWT_SECRET);
      const userId = decoded?._id;
      const role = decoded?.role;
      if (userId) {
        client.data.userId = String(userId);
        client.join(`user:${userId}`);
        if (role) client.join(`role:${role}`);
      }
    } catch {
      // token invalide/expiré → on laisse le socket anonyme (pas de throw :
      // ne jamais casser la connexion temps réel existante).
    }
  }

  handleDisconnect(client: Socket) {
    // this.logger.log(`Client disconnected: ${client.id}`);
  }

  /** Émission CIBLÉE vers un utilisateur (room `user:{id}`) — jamais broadcast. */
  emitToUser(userId: string, payload: any) {
    if (!userId) return;
    this.server.to(`user:${userId}`).emit('notification.new', payload);
  }

  /** Émission ciblée vers tous les porteurs d'un rôle (room `role:{ROLE}`). */
  emitToRole(role: string, payload: any) {
    if (!role) return;
    this.server.to(`role:${role}`).emit('notification.new', payload);
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

  blAddedNotification(data: any) {
    this.server.emit('blAddedNotification', data);
  }

  sendComponentToCoordinatorFromMagasin(data) {
    this.server.emit('component:sent_to_coordinator', data);
  }
  sendComponentToMagasinFromCoordinator(data) {
    this.server.emit('component:confirmed_by_coordinator', data);
  }

  /**
   *
   * @param ticket
   * content will contains ticket and profile data
   * target == profile
   *
   */
  updateTicket(message: { action: string; content: any; target?: any }) {
    this.server.emit('updateTicket', message);
  }

  // ---- Generic operational alerts (stagnation, future ops monitors) -------
  // Two events keep the contract small: a new alert appeared, or an alert
  // was resolved. Frontend routes by `type` to badge/toast/inbox views.

  alertCreated(payload: any) {
    this.server.emit('alert.created', payload);
  }

  alertResolved(payload: any) {
    this.server.emit('alert.resolved', payload);
  }

  // ---- Import DI en bloc : progression d'un job d'exécution ----------------
  // Broadcast (comme le reste du gateway) → le payload porte OBLIGATOIREMENT le
  // `jobId` pour que le client filtre les événements d'un autre job/utilisateur.
  diImportProgress(payload: {
    jobId: string;
    done: number;
    total: number;
    currentRef: string | null;
    phase: string;
  }) {
    this.server.emit('di-import.progress', payload);
  }
}
