import { JwtService } from '@nestjs/jwt';
import { JWT_SECRET } from '../auth/jwt.constants';
import { currentActor, runWithRequest } from './request-context';

/**
 * `currentActor()` identifie l'auteur d'une action pour les notifications :
 * `req.user` (mutation gardée) d'abord, sinon vérification SOUPLE du Bearer
 * (mutation non gardée), `undefined` hors requête (cron / ACTION).
 */
describe('request-context — currentActor', () => {
  const sign = (payload: object, secret = JWT_SECRET) =>
    new JwtService({ secret }).sign(payload);

  it('undefined hors requête (cron / ACTION)', () => {
    expect(currentActor()).toBeUndefined();
  });

  it('req.user (garde JWT) est prioritaire sur le jeton', () => {
    const user = { _id: 'u1', username: 'hamdi', role: 'COORDIANTOR' };
    const token = sign({ _id: 'other', username: 'other', role: 'TECH' });
    runWithRequest(
      { user, headers: { authorization: `Bearer ${token}` } },
      () => expect(currentActor()).toBe(user),
    );
  });

  it('décode un Bearer valide sur une mutation NON gardée', () => {
    const token = sign({ _id: 'u2', username: 'tech1', role: 'TECH' });
    runWithRequest({ headers: { authorization: `Bearer ${token}` } }, () =>
      expect(currentActor()).toEqual(
        expect.objectContaining({ _id: 'u2', username: 'tech1', role: 'TECH' }),
      ),
    );
  });

  it('jeton signé avec un autre secret → null (jamais d\'exception)', () => {
    const token = sign({ _id: 'x', username: 'pirate' }, 'autre-secret');
    runWithRequest({ headers: { authorization: `Bearer ${token}` } }, () =>
      expect(currentActor()).toBeNull(),
    );
  });

  it('pas de jeton → null', () => {
    runWithRequest({ headers: {} }, () => expect(currentActor()).toBeNull());
  });

  it('le contexte survit aux await (timers + promesses)', async () => {
    const user = { _id: 'u3', username: 'magasin1', role: 'MAGASIN' };
    await runWithRequest({ user }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      expect(currentActor()).toBe(user);
    });
  });
});
