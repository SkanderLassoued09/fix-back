// DiService/DiResolver tirent nanoid (ESM) → mock, comme les autres specs DI.
jest.mock('nanoid', () => ({ nanoid: () => 'rand' }));

import { DiResolver } from './di.resolver';
import { DiService } from './di.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';

/**
 * Feature 1 — Annulation d'une DI (bouton coordinateur) :
 *  - AUTHENTIFIÉE (`@UseGuards(JwtAuthGuard)`) → sans token = refusée ;
 *  - mot de passe vérifié CÔTÉ SERVEUR (mauvais MDP ⇒ AUCUNE modif) ;
 *  - motif sur liste blanche, « AUTRE » ⇒ texte libre obligatoire ;
 *  - persistance du motif + qui/quand/parClient + notification Discord.
 */

// ---------------------------------------------------------------------------
// Resolver — mot de passe + garde + délégation
// ---------------------------------------------------------------------------
function makeResolver(verifyResult: boolean) {
  const diService = {
    annulerDi: jest.fn().mockResolvedValue({ _id: 'DI1', status: 'ANNULER' }),
  };
  const profileService = {
    verifyPassword: jest.fn().mockResolvedValue(verifyResult),
  };
  const resolver = new DiResolver(
    diService as any,
    {} as any,
    {} as any,
    profileService as any,
  );
  return { resolver, diService, profileService };
}

const INPUT = {
  diId: 'DI1',
  parClient: true,
  motif: 'CLIENT_RENONCE',
  commentaire: 'ok',
  password: 'secret',
};
const PROFILE = { _id: 'U1', username: 'coord' } as any;

describe('DiResolver.annulerDi — auth + mot de passe', () => {
  it('est protégée par JwtAuthGuard (mutation sans token → refusée)', () => {
    const guards =
      Reflect.getMetadata('__guards__', DiResolver.prototype.annulerDi) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });

  it('mot de passe FAUX → « Mot de passe incorrect », annulerDi jamais appelé', async () => {
    const { resolver, diService, profileService } = makeResolver(false);
    await expect(resolver.annulerDi(INPUT as any, PROFILE)).rejects.toThrow(
      /Mot de passe incorrect/i,
    );
    expect(profileService.verifyPassword).toHaveBeenCalledWith('coord', 'secret');
    expect(diService.annulerDi).not.toHaveBeenCalled(); // AUCUNE modification
  });

  it('mot de passe BON → délègue avec annulePar = utilisateur courant', async () => {
    const { resolver, diService } = makeResolver(true);
    await resolver.annulerDi(INPUT as any, PROFILE);
    expect(diService.annulerDi).toHaveBeenCalledWith('DI1', {
      parClient: true,
      motif: 'CLIENT_RENONCE',
      motifAutre: undefined,
      commentaire: 'ok',
      annulePar: 'coord', // username de l'utilisateur courant (lisible)
    });
  });
});

// ---------------------------------------------------------------------------
// Service — motif whitelist + persistance + Discord
// ---------------------------------------------------------------------------
function makeSvc(currentStatus: string | null = 'PENDING3') {
  const svc: any = Object.create(DiService.prototype);
  const updated = { _id: 'DI1', status: 'ANNULER' };
  svc.diModel = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: async () => (currentStatus === null ? null : { status: currentStatus }),
      }),
    })),
    findOneAndUpdate: jest.fn(async () => updated),
  };
  svc.discordHookService = {
    sendDiCancelled: jest.fn().mockResolvedValue({}),
  };
  svc.captureDiscordFailure = jest.fn();
  return { svc, updated };
}

const baseData = {
  parClient: true,
  motif: 'CLIENT_RENONCE',
  commentaire: 'client injoignable',
  annulePar: 'U1',
};

describe('DiService.annulerDi — persistance & garde métier', () => {
  it('motif valide → statut ANNULER + motif/qui/quand/parClient persistés + Discord', async () => {
    const { svc } = makeSvc('PENDING3');
    await svc.annulerDi('DI1', baseData);
    const [filter, update] = svc.diModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'DI1' });
    expect(update.$set.status).toBe('ANNULER');
    expect(update.$set.annulationMotif).toBe('Client a renoncé'); // libellé serveur
    expect(update.$set.annulationParClient).toBe(true);
    expect(update.$set.annulationCommentaire).toBe('client injoignable');
    expect(update.$set.annulePar).toBe('U1');
    expect(update.$set.annuleLe).toBeInstanceOf(Date);
    expect(svc.discordHookService.sendDiCancelled).toHaveBeenCalledTimes(1);
  });

  it('motif « AUTRE » SANS texte → refusé, AUCUNE écriture', async () => {
    const { svc } = makeSvc('PENDING3');
    await expect(
      svc.annulerDi('DI1', { ...baseData, motif: 'AUTRE', motifAutre: '   ' }),
    ).rejects.toThrow(/Autre.*obligatoire/i);
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('motif « AUTRE » AVEC texte → persiste le texte libre comme motif', async () => {
    const { svc } = makeSvc('PENDING3');
    await svc.annulerDi('DI1', {
      ...baseData,
      motif: 'AUTRE',
      motifAutre: 'Parti à l’étranger',
    });
    const [, update] = svc.diModel.findOneAndUpdate.mock.calls[0];
    expect(update.$set.annulationMotif).toBe('Parti à l’étranger');
  });

  it('code motif inconnu → refusé, AUCUNE écriture', async () => {
    const { svc } = makeSvc('PENDING3');
    await expect(
      svc.annulerDi('DI1', { ...baseData, motif: 'HACK' }),
    ).rejects.toThrow(/invalide/i);
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('DI déjà ANNULER → refusée (idempotence métier), AUCUNE écriture', async () => {
    const { svc } = makeSvc('ANNULER');
    await expect(svc.annulerDi('DI1', baseData)).rejects.toThrow(/déjà annulée/i);
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('DI introuvable → NOT_FOUND, AUCUNE écriture', async () => {
    const { svc } = makeSvc(null);
    await expect(svc.annulerDi('DI1', baseData)).rejects.toThrow(/introuvable/i);
    expect(svc.diModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('annulation autorisée depuis N’IMPORTE QUEL statut (ex. INREPARATION)', async () => {
    const { svc } = makeSvc('INREPARATION');
    await svc.annulerDi('DI1', baseData);
    expect(svc.diModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
