import { ProfileResolver } from './profile.resolver';
import { ProfileService } from './profile.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';

/**
 * « Mon profil » — changement de mot de passe par l'utilisateur lui-même.
 *
 * Ce que ces tests verrouillent :
 *  - l'acteur vient du JWT, jamais d'un argument client ;
 *  - la garde ne suffisant pas à rejeter un anonyme, le resolver le fait ;
 *  - un mot de passe actuel faux n'écrit RIEN ;
 *  - l'écriture passe par `save()` pour que le hook de hachage se déclenche
 *    (un `findOneAndUpdate` stockerait le mot de passe en clair).
 */

// ── Resolver ───────────────────────────────────────────────────────────────
function makeResolver() {
  const profileService = { changeOwnPassword: jest.fn().mockResolvedValue(true) };
  const resolver = new ProfileResolver(profileService as any);
  return { resolver, profileService };
}

const INPUT = { currentPassword: 'ancien123', newPassword: 'nouveau12345' };

describe('ProfileResolver.changeMyPassword', () => {
  it('est protégée par JwtAuthGuard', () => {
    const guards =
      Reflect.getMetadata(
        '__guards__',
        ProfileResolver.prototype.changeMyPassword,
      ) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });

  it('appelant ANONYME → UNAUTHENTICATED, le service n’est jamais appelé', async () => {
    // `JwtAuthGuard.handleRequest` ne lève pas : `profile` peut être undefined
    // alors même que la garde a laissé passer la requête.
    const { resolver, profileService } = makeResolver();
    await expect(
      resolver.changeMyPassword(INPUT as any, undefined as any),
    ).rejects.toThrow(/Authentification requise/i);
    expect(profileService.changeOwnPassword).not.toHaveBeenCalled();
  });

  it('utilise le username du JWT, jamais un identifiant fourni par le client', async () => {
    const { resolver, profileService } = makeResolver();
    // Le client tente de viser un autre compte : l'argument doit être ignoré.
    const hostile = { ...INPUT, username: 'victime', _id: 'AUTRE' };
    await resolver.changeMyPassword(hostile as any, {
      username: 'magasin',
    } as any);
    expect(profileService.changeOwnPassword).toHaveBeenCalledWith(
      'magasin',
      INPUT.currentPassword,
      INPUT.newPassword,
    );
  });
});

// ── Service ────────────────────────────────────────────────────────────────
function makeService(doc: any, verify: boolean): any {
  const svc: any = Object.create(ProfileService.prototype);
  svc.profileModel = { findOne: jest.fn().mockResolvedValue(doc) };
  svc.verifyPassword = jest.fn().mockResolvedValue(verify);
  return svc;
}

function makeDoc(over: Record<string, any> = {}) {
  return { username: 'magasin', password: '$2b$10$hash', isDeleted: false, save: jest.fn().mockResolvedValue(true), ...over };
}

describe('ProfileService.changeOwnPassword', () => {
  it('mot de passe actuel FAUX → rejet, rien n’est écrit', async () => {
    const doc = makeDoc();
    const svc = makeService(doc, false);
    await expect(
      svc.changeOwnPassword('magasin', 'faux', 'nouveau12345'),
    ).rejects.toThrow(/actuel incorrect/i);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('nouveau identique à l’actuel → rejet (changement illusoire)', async () => {
    const doc = makeDoc();
    const svc = makeService(doc, true);
    await expect(
      svc.changeOwnPassword('magasin', 'meme12345', 'meme12345'),
    ).rejects.toThrow(/différent/i);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('compte désactivé → rejet même avec un jeton encore valide', async () => {
    // Le JWT vit 365 j et ne porte pas `isDeleted`.
    const doc = makeDoc({ isDeleted: true });
    const svc = makeService(doc, true);
    await expect(
      svc.changeOwnPassword('magasin', 'ancien123', 'nouveau12345'),
    ).rejects.toThrow(/désactivé/i);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('cas nominal → affecte le NOUVEAU mot de passe puis save() (le hook hache)', async () => {
    const doc = makeDoc();
    const svc = makeService(doc, true);
    await expect(
      svc.changeOwnPassword('magasin', 'ancien123', 'nouveau12345'),
    ).resolves.toBe(true);
    // En clair sur le document : c'est le hook `pre('save')` qui hache.
    expect(doc.password).toBe('nouveau12345');
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it('n’utilise PAS findOneAndUpdate (qui contournerait le hachage)', async () => {
    const doc = makeDoc();
    const svc = makeService(doc, true);
    svc.profileModel.findOneAndUpdate = jest.fn();
    svc.profileModel.updateOne = jest.fn();
    await svc.changeOwnPassword('magasin', 'ancien123', 'nouveau12345');
    expect(svc.profileModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(svc.profileModel.updateOne).not.toHaveBeenCalled();
  });
});
