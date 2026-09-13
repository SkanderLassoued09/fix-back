import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthGuard } from '@nestjs/passport';
import { GraphQLError } from 'graphql';

/** Erreur d'authentification au format GraphQL du dépôt. `extensions.code` est
 *  lu par `AllExceptionsFilter`, qui classe `UNAUTHENTICATED` parmi les codes
 *  ATTENDUS : le refus est donc journalisé en `LOW` sans alerte Discord. */
const unauthenticated = () =>
  new GraphQLError('Authentification requise.', {
    extensions: { code: 'UNAUTHENTICATED' },
  });

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext) {
    const ctx = GqlExecutionContext.create(context);
    const request = ctx.getContext().req;
    if (!request) {
      throw unauthenticated();
    }
    return request;
  }

  /**
   * REFUSE explicitement quand l'authentification échoue.
   *
   * L'implémentation précédente était `if (user) return user;` — elle
   * retombait donc sur `undefined` sans jamais lever. Or Passport affecte la
   * valeur retournée à `req.user` puis `canActivate` résout `true` : **toute
   * requête anonyme traversait la garde** avec `req.user === undefined`, et les
   * resolvers déréférençaient `profile._id` → « Cannot read properties of
   * undefined ». C'est le contournement d'authentification S12 des
   * known-issues, et la cause des remontées 500 sur `unreadNotificationCount`
   * et `getDiStatusCounts`.
   *
   * `err` était de surcroît ignoré : une erreur de stratégie (jeton malformé,
   * signature invalide) disparaissait silencieusement. On la propage.
   */
  handleRequest(err: any, user: any) {
    if (err || !user) {
      throw err || unauthenticated();
    }
    return user;
  }
}
