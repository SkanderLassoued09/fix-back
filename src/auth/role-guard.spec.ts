import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { RolesGuard } from './role-guard';
import { Role } from '../profile/role-decorator';

/**
 * RolesGuard — enforcement serveur utilisé par la mutation `createReunionPV`.
 * Rôles autorisés Réunion : admin (gestion + technique), manager, coordinateur
 * (valeur RÉELLE `COORDIANTOR`). Tout autre rôle, ou l'absence d'utilisateur
 * (token absent/invalide via le bug S12 de JwtAuthGuard), doit être REFUSÉ.
 */
describe('RolesGuard — accès Réunion', () => {
  const REUNION_ROLES = [
    Role.ADMIN_MANAGER,
    Role.ADMIN_TECH,
    Role.MANAGER,
    Role.COORDIANTOR,
  ];

  function runWith(opts: {
    required?: Role[] | undefined;
    user: { role?: string } | undefined;
  }): boolean {
    const reflector = {
      getAllAndOverride: () => opts.required,
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    jest.spyOn(GqlExecutionContext, 'create').mockReturnValue({
      getContext: () => ({ req: { user: opts.user } }),
    } as any);

    const ctx = {
      getHandler: () => ({}),
      getClass: () => ({}),
    } as any;
    return guard.canActivate(ctx);
  }

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['ADMIN_MANAGER', true],
    ['ADMIN_TECH', true],
    ['MANAGER', true],
    ['COORDIANTOR', true], // valeur réelle (typo persistée)
  ])('AUTORISE %s → %p', (role, expected) => {
    expect(runWith({ required: REUNION_ROLES, user: { role } })).toBe(expected);
  });

  it.each([['TECH'], ['MAGASIN'], ['COORDINATOR']])(
    'REFUSE %s (hors périmètre — dont la valeur bien orthographiée COORDINATOR)',
    (role) => {
      expect(runWith({ required: REUNION_ROLES, user: { role } })).toBe(false);
    },
  );

  it('REFUSE un utilisateur absent (token manquant/invalide, bug S12) sans planter', () => {
    expect(runWith({ required: REUNION_ROLES, user: undefined })).toBe(false);
  });

  it('REFUSE un utilisateur sans rôle', () => {
    expect(runWith({ required: REUNION_ROLES, user: {} })).toBe(false);
  });

  it('laisse passer quand aucune restriction @Roles n’est déclarée', () => {
    expect(runWith({ required: undefined, user: { role: 'TECH' } })).toBe(true);
  });
});
