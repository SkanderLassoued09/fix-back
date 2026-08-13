import { BadRequestException } from '@nestjs/common';
import { TierAliasService } from './tier-alias.service';

/**
 * Mémoire des décisions (`tier_aliases`) : enregistrement (revalidé), lecture,
 * et cohérence (`isValid`) contre l'état courant.
 */
function makeSvc(opts: { existingTiers?: Record<string, 'CLIENT' | 'SOCIETE'> } = {}) {
  const store = new Map<string, any>(); // key = importedNameNormalized
  const existing = opts.existingTiers ?? {};
  const aliasModel = {
    findOneAndUpdate: jest.fn(async (q: any, upd: any) => {
      const key = q.importedNameNormalized;
      const prev = store.get(key) ?? { importedNameNormalized: key };
      const next = { ...prev, ...upd.$set, updatedAt: new Date() };
      store.set(key, next);
      return next;
    }),
    findOne: jest.fn((q: any) => ({
      lean: async () => store.get(q.importedNameNormalized) ?? null,
    })),
    find: jest.fn(() => ({ lean: async () => [...store.values()] })),
  };
  // exists() → tiers présents avec le bon type (isDeleted ignoré ici : les tiers
  // supprimés ne sont simplement pas dans `existing`).
  const modelFor = (type: 'CLIENT' | 'SOCIETE') => ({
    exists: jest.fn(async (q: any) =>
      existing[q._id] === type ? { _id: q._id } : null,
    ),
  });
  const svc = new TierAliasService(
    aliasModel as any,
    modelFor('CLIENT') as any,
    modelFor('SOCIETE') as any,
  );
  return { svc, store };
}

describe('TierAliasService — enregistrement / lecture', () => {
  it('record : crée un alias (tiers valide) avec decidedBy authentifié', async () => {
    const { svc } = makeSvc({ existingTiers: { CMP1: 'SOCIETE' } });
    const a = await svc.record({
      importedName: 'COGEMHY',
      tierId: 'CMP1',
      type: 'SOCIETE',
      decidedBy: 'U1',
    });
    expect(a.importedNameNormalized).toBe('cogemhy');
    expect(a.tierId).toBe('CMP1');
    expect(a.type).toBe('SOCIETE');
    expect(a.decidedBy).toBe('U1');
  });

  it('record : normalise le nom (variante → clé canonique)', async () => {
    const { svc } = makeSvc({ existingTiers: { CMP2: 'SOCIETE' } });
    const a = await svc.record({
      importedName: 'PERSO (PROMODAR)',
      tierId: 'CMP2',
      type: 'SOCIETE',
      decidedBy: 'U1',
    });
    expect(a.importedNameNormalized).toBe('perso promodar');
  });

  it('findByName : retrouve un alias existant', async () => {
    const { svc } = makeSvc({ existingTiers: { C9: 'CLIENT' } });
    await svc.record({ importedName: 'ACME', tierId: 'C9', type: 'CLIENT', decidedBy: 'U1' });
    const a = await svc.findByName('acme');
    expect(a?.tierId).toBe('C9');
  });

  it('findByName : alias inexistant → null', async () => {
    const { svc } = makeSvc();
    expect(await svc.findByName('inconnu')).toBeNull();
  });

  it('record : tiers introuvable / mauvais type → REJET (BadRequest)', async () => {
    const { svc } = makeSvc({ existingTiers: { CMP1: 'SOCIETE' } });
    // tierId inexistant
    await expect(
      svc.record({ importedName: 'X', tierId: 'NOPE', type: 'SOCIETE', decidedBy: 'U1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // bon id mais mauvais type (CMP1 est SOCIETE, pas CLIENT)
    await expect(
      svc.record({ importedName: 'X', tierId: 'CMP1', type: 'CLIENT', decidedBy: 'U1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TierAliasService — cohérence (isValid)', () => {
  const clientIds = new Set(['C1', 'C2']);
  const companyIds = new Set(['CMP1']);

  it('alias CLIENT valide (id présent côté clients)', () => {
    const { svc } = makeSvc();
    expect(svc.isValid({ tierId: 'C1', type: 'CLIENT' }, clientIds, companyIds)).toBe(true);
  });

  it('alias SOCIETE valide (id présent côté sociétés)', () => {
    const { svc } = makeSvc();
    expect(svc.isValid({ tierId: 'CMP1', type: 'SOCIETE' }, clientIds, companyIds)).toBe(true);
  });

  it('alias vers tiers SUPPRIMÉ (id absent) → invalide', () => {
    const { svc } = makeSvc();
    expect(svc.isValid({ tierId: 'C_GONE', type: 'CLIENT' }, clientIds, companyIds)).toBe(false);
  });

  it('alias au TYPE devenu incohérent (id existe mais côté opposé) → invalide', () => {
    const { svc } = makeSvc();
    // dit CLIENT mais l'id est côté sociétés
    expect(svc.isValid({ tierId: 'CMP1', type: 'CLIENT' }, clientIds, companyIds)).toBe(false);
  });

  it('null / sans tierId → invalide', () => {
    const { svc } = makeSvc();
    expect(svc.isValid(null, clientIds, companyIds)).toBe(false);
    expect(svc.isValid({ type: 'CLIENT' }, clientIds, companyIds)).toBe(false);
  });
});
