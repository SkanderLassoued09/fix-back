import { AsyncLocalStorage } from 'async_hooks';
import { JwtService } from '@nestjs/jwt';
import { JWT_SECRET } from '../auth/jwt.constants';

/**
 * Contexte de requête (AsyncLocalStorage) — permet à un service profond
 * (ex. `DiscordHookService`) de savoir QUI a déclenché l'action sans faire
 * transiter un paramètre `actor` à travers la trentaine de méthodes de
 * `DiService` et leurs resolvers.
 *
 * Monté UNE fois dans `main.ts` (mode HTTP), APRÈS les body-parsers : un
 * AsyncLocalStorage peut perdre son contexte à travers les événements de flux
 * du parsing du corps ; après eux, il ne reste que des `next()` synchrones et
 * Apollo, qui propagent le contexte.
 */

export interface RequestActor {
  _id?: string;
  username?: string;
  role?: string;
  email?: string;
}

interface RequestStore {
  req: any;
}

const storage = new AsyncLocalStorage<RequestStore>();
const jwt = new JwtService({ secret: JWT_SECRET });

export function runWithRequest<T>(req: any, next: () => T): T {
  return storage.run({ req }, next);
}

/**
 * Acteur de la requête courante :
 *   - `req.user` quand une garde JWT a tourné (mutation gardée) ;
 *   - sinon vérification SOUPLE du jeton `Bearer` — beaucoup de mutations DI
 *     n'ont pas de garde, mais le front envoie toujours le jeton. Aucun refus
 *     ici : jeton absent / invalide / expiré → `null` ;
 *   - `undefined` hors requête (mode ACTION, cron) : pas d'acteur humain.
 */
export function currentActor(): RequestActor | null | undefined {
  const store = storage.getStore();
  if (!store) return undefined;
  const req = store.req;
  if (req?.user) return req.user;

  const header = req?.headers?.authorization;
  const match =
    typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  if (!match) return null;
  try {
    const payload: any = jwt.verify(match[1]);
    return {
      _id: payload?._id,
      role: payload?.role,
      username: payload?.username,
      email: payload?.email,
    };
  } catch {
    return null;
  }
}
