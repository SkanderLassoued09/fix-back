import { JwtAuthGuard } from './jwt-auth-guard';

/**
 * S12 — `JwtAuthGuard` doit REFUSER les appels non authentifiés.
 *
 * L'ancienne implémentation (`if (user) return user;`) retombait sur
 * `undefined` sans lever : Passport affectait alors `req.user = undefined` et
 * `canActivate` résolvait `true`, si bien que les resolvers gardés s'exécutaient
 * pour un appelant anonyme et plantaient sur `profile._id`.
 */
describe('JwtAuthGuard.handleRequest', () => {
  const guard = new JwtAuthGuard();

  it('utilisateur valide → le laisse passer tel quel', () => {
    const user = { _id: 'U1', username: 'magasin', role: 'MAGASIN' };
    expect(guard.handleRequest(null, user)).toBe(user);
  });

  it('AUCUN utilisateur (jeton absent/invalide) → lève UNAUTHENTICATED', () => {
    expect(() => guard.handleRequest(null, undefined)).toThrow(
      /Authentification requise/i,
    );
    try {
      guard.handleRequest(null, undefined);
    } catch (e: any) {
      // Le filtre global classe ce code parmi les erreurs ATTENDUES : refus
      // journalisé en LOW, sans alerte Discord.
      expect(e.extensions?.code).toBe('UNAUTHENTICATED');
    }
  });

  it('utilisateur `null` → lève aussi (pas seulement `undefined`)', () => {
    expect(() => guard.handleRequest(null, null)).toThrow(
      /Authentification requise/i,
    );
  });

  it('erreur de stratégie → PROPAGÉE (elle était silencieusement ignorée)', () => {
    const boom = new Error('jwt malformed');
    expect(() => guard.handleRequest(boom, undefined)).toThrow('jwt malformed');
    // Même avec un utilisateur, une erreur de stratégie reste une erreur.
    expect(() => guard.handleRequest(boom, { _id: 'U1' })).toThrow(
      'jwt malformed',
    );
  });
});
