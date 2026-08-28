// bcrypt est lourd/asynchrone : on le mocke pour piloter la comparaison.
jest.mock('bcrypt', () => ({ compare: jest.fn() }));
import * as bcrypt from 'bcrypt';

import { AuthService } from './auth.service';

/**
 * feat/block-deleted-profile-login — un profil SUPPRIMÉ (`isDeleted: true`) ne
 * peut PAS se connecter, même avec le bon mot de passe. Garde server-authoritative
 * sur les deux points d'entrée du login :
 *   - `validateUser` (stratégie locale Passport, via GqlAuthGuard) ;
 *   - `login` (défense en profondeur, appel direct).
 */

function makeSvc(user: any) {
  const svc: any = Object.create(AuthService.prototype);
  svc.profileService = { findOneForAuth: jest.fn().mockResolvedValue(user) };
  svc.profileModel = { updateOne: jest.fn().mockResolvedValue({}) };
  svc.jwtService = { sign: jest.fn().mockReturnValue('signed-jwt') };
  return svc;
}

describe('AuthService — refus des comptes supprimés (isDeleted)', () => {
  beforeEach(() => (bcrypt.compare as jest.Mock).mockReset());

  it('validateUser : profil isDeleted → REFUS, AVANT toute vérif de mot de passe', async () => {
    const svc = makeSvc({
      _id: 'P1',
      username: 'x',
      password: 'hash',
      isDeleted: true,
    });
    await expect(svc.validateUser('x', 'pw')).rejects.toThrow(/désactivé/);
    // Le mot de passe n'est même pas comparé.
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it('validateUser : profil ACTIF + bon mot de passe → OK (sans le hash)', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const svc = makeSvc({
      _id: 'P1',
      username: 'x',
      password: 'hash',
      isDeleted: false,
      role: 'TECH',
    });
    const res = await svc.validateUser('x', 'pw');
    expect(res.username).toBe('x');
    expect(res.password).toBeUndefined();
  });

  it('login : profil isDeleted → REFUS (défense en profondeur), aucune session ouverte', async () => {
    const svc = makeSvc({ _id: 'P1', username: 'x', isDeleted: true });
    await expect(
      svc.login({ username: 'x', password: 'pw' }),
    ).rejects.toThrow(/désactivé/);
    // Ne marque JAMAIS le compte comme connecté.
    expect(svc.profileModel.updateOne).not.toHaveBeenCalled();
  });

  it('login : profil ACTIF (non connecté) → signe le JWT', async () => {
    const svc = makeSvc({
      _id: 'P1',
      username: 'x',
      email: 'x@y',
      role: 'TECH',
      isDeleted: false,
      isConnected: false,
    });
    const out = await svc.login({ username: 'x', password: 'pw' });
    expect(out.access_token).toBe('signed-jwt');
    expect(svc.profileModel.updateOne).toHaveBeenCalled();
  });
});
