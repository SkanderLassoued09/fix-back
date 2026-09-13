import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Profile, ProfileDocument } from '../profile/entities/profile.entity';

/**
 * LIBÉRATION NOCTURNE DES SESSIONS — remet `isConnected` à `false` sur tous les
 * profils encore marqués connectés.
 *
 * POURQUOI. L'ERP impose une session unique : `AuthService.login` refuse avec
 * `ACCOUNT_ALREADY_CONNECTED` si le drapeau vaut déjà `true`. Or ce drapeau
 * n'est remis à `false` QUE par le navigateur — clic sur Déconnexion, ou une
 * balise `pagehide` envoyée en best-effort. Un crash, un onglet tué par l'OS,
 * une coupure réseau pendant le `pagehide`, ou un `logout` au jeton illisible
 * (qui sort en silence) laissent donc le compte VERROUILLÉ DÉFINITIVEMENT :
 * `handleDisconnect` de la passerelle websocket est un corps vide, il n'existe
 * ni index TTL ni heartbeat, le JWT dure 365 jours, et aucune mutation admin ne
 * remet le drapeau à zéro. Le seul recours était un `updateMany` à la main.
 *
 * Déclenché par le cron de minuit Africa/Tunis (`AppCronService`).
 *
 * C'est un FILET, pas une réparation : la cause reste que la déconnexion dépend
 * entièrement du navigateur.
 */
@Injectable()
export class SessionCleanupService {
  private readonly logger = new Logger(SessionCleanupService.name);

  constructor(
    @InjectModel(Profile.name)
    private readonly profileModel: Model<ProfileDocument>,
  ) {}

  /**
   * Libère les sessions bloquées. Retourne un résumé pour le log du cron.
   */
  async run(): Promise<{ released: number }> {
    this.logger.log('START libération des sessions bloquées');

    // ⚠️ Le filtre `{ isConnected: true }` est INDISPENSABLE — ne jamais le
    // remplacer par `{}`. Mongoose applique `timestamps` aux `updateMany`, donc
    // un filtre vide réécrirait `updatedAt` sur TOUS les profils chaque nuit :
    // on détruirait le seul indicateur d'ancienneté de session dont on dispose
    // (il n'existe pas de `connectedAt`). Le filtre rend en prime
    // `modifiedCount` significatif — c'est le nombre réel de comptes libérés.
    //
    // Les comptes en suppression logique gardent `isConnected: true` (leur
    // suppression ne touche que `isDeleted`) : le filtre les couvre aussi.
    const res = await this.profileModel.updateMany(
      { isConnected: true },
      { $set: { isConnected: false } },
    );

    const released = res?.modifiedCount ?? 0;
    this.logger.log(`END libération des sessions · libérées=${released}`);
    return { released };
  }
}
