import { toProfileRole, toProfileRoles } from './role-mapping';

/**
 * Table de correspondance vocabulaire « humain » (alertes / STATUS_DI) →
 * valeur profil RÉELLE (coquille `COORDIANTOR` comprise). Aucun orphelin sur
 * les 6 rôles humains connus.
 */
describe('role-mapping — alignement de vocabulaire', () => {
  it('mappe chaque rôle humain vers la valeur profil réelle (coquille comprise)', () => {
    expect(toProfileRole('Admin_Manager')).toBe('ADMIN_MANAGER');
    expect(toProfileRole('Admin_Tech')).toBe('ADMIN_TECH');
    expect(toProfileRole('Manager')).toBe('MANAGER');
    expect(toProfileRole('Tech')).toBe('TECH');
    expect(toProfileRole('Magasin')).toBe('MAGASIN');
    // ⚠️ la coquille RÉELLE, pas 'COORDINATOR'
    expect(toProfileRole('Coordinator')).toBe('COORDIANTOR');
  });

  it('est idempotent : une valeur profil déjà correcte est renvoyée telle quelle', () => {
    expect(toProfileRole('COORDIANTOR')).toBe('COORDIANTOR');
    expect(toProfileRole('TECH')).toBe('TECH');
    expect(toProfileRole('ADMIN_MANAGER')).toBe('ADMIN_MANAGER');
  });

  it('ne devine JAMAIS : la faute inverse « COORDINATOR » n’est PAS une valeur profil', () => {
    // 'COORDINATOR' (enum auth, désaligné) n'existe pas en base → non résolu.
    expect(toProfileRole('COORDINATOR')).toBeNull();
  });

  it('rôle inconnu → null (non résolu)', () => {
    expect(toProfileRole('Ghost')).toBeNull();
    expect(toProfileRole('')).toBeNull();
    expect(toProfileRole(null)).toBeNull();
  });

  it('toProfileRoles sépare résolus / non résolus (dédupliqués)', () => {
    const r = toProfileRoles(['Coordinator', 'Manager', 'Ghost', 'Manager']);
    expect(r.resolved.sort()).toEqual(['COORDIANTOR', 'MANAGER']);
    expect(r.unresolved).toEqual(['Ghost']);
  });
});
