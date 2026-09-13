import { DiCategoryService } from './di_category.service';
import { DiCategoryResolver } from './di_category.resolver';

/**
 * Référentiel PARTAGÉ : créer une catégorie de diagnostic depuis l'assistant
 * technicien la rend visible par toute l'équipe. Deux garanties sont testées
 * ici, parce que c'est exactement ce qui manquait :
 *
 *  1. le service DIT s'il a créé ou s'il a trouvé un doublon (`created`) —
 *     avant, le doublon revenait indistinguable d'une création ;
 *  2. la cloche ne sonne QUE sur une création réelle. Sans ce garde-fou,
 *     chaque quasi-doublon (« Carte mère » vs « carte mere ») notifierait
 *     l'encadrement alors que rien n'a été ajouté.
 */

/** Service avec ses dépendances Mongoose simulées (idiome du dépôt : pas de
 *  TestingModule Nest, on greffe sur le prototype). */
function makeService(existing: any = null) {
  const svc: any = Object.create(DiCategoryService.prototype);
  const saved = { _id: 'uuid-new', category: 'Carte mère', isDeleted: false };
  const model: any = jest.fn().mockImplementation((data: any) => ({
    save: jest.fn().mockResolvedValue({ ...saved, ...data }),
  }));
  model.findOne = jest.fn().mockResolvedValue(existing);
  svc.DiCategoryModel = model;
  return { svc, model };
}

function makeResolver(serviceResult: any) {
  const emit = jest.fn().mockResolvedValue({ _id: 'evt1' });
  const resolver: any = Object.create(DiCategoryResolver.prototype);
  resolver.logger = { warn: jest.fn() };
  resolver.diCategoryService = {
    createDiCategory: jest.fn().mockResolvedValue(serviceResult),
  };
  resolver.notificationService = { emit };
  return { resolver, emit };
}

describe('DiCategoryService.createDiCategory — création vs doublon', () => {
  it('signale created:true et insère quand le nom est libre', async () => {
    const { svc, model } = makeService(null);

    const res = await svc.createDiCategory('  Carte mère  ');

    expect(res.created).toBe(true);
    expect(res.doc.category).toBe('Carte mère'); // trimé
    expect(model).toHaveBeenCalledTimes(1); // un document construit
  });

  it('signale created:false et renvoie l’EXISTANT sur un doublon de casse', async () => {
    const existing = { _id: 'uuid-old', category: 'Carte mère' };
    const { svc, model } = makeService(existing);

    const res = await svc.createDiCategory('CARTE MÈRE');

    expect(res.created).toBe(false);
    expect(res.doc).toBe(existing);
    expect(model).not.toHaveBeenCalled(); // rien d'inséré
  });

  it('refuse un nom vide ou fait d’espaces', async () => {
    const { svc } = makeService(null);
    await expect(svc.createDiCategory('   ')).rejects.toThrow(
      'Category name is required',
    );
  });
});

describe('DiCategoryResolver.createDiCategory — notification ERP', () => {
  const profile: any = { _id: 'tech-1', role: 'TECH' };

  it('émet UNE notification attribuée quand la catégorie est réellement créée', async () => {
    const doc = { _id: 'uuid-new', category: 'Carte mère' };
    const { resolver, emit } = makeResolver({ doc, created: true });

    const out = await resolver.createDiCategory('Carte mère', profile);

    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0][0];
    expect(payload.type).toBe('DI_CATEGORY_CREATED');
    expect(payload.actorId).toBe('tech-1');
    expect(payload.actorRole).toBe('TECH');
    expect(payload.diId).toBeNull(); // une catégorie n'est pas une DI
    expect(payload.message).toContain('Carte mère');
    expect(payload.payload).toEqual({
      categoryId: 'uuid-new',
      category: 'Carte mère',
    });
    // Vocabulaire HUMAIN : `toProfileRoles()` fait la traduction (dont la
    // coquille COORDIANTOR). Des valeurs d'enum ici seraient un désalignement.
    expect(payload.notify.roles).toEqual([
      'Manager',
      'Admin_Manager',
      'Coordinator',
      'Admin_Tech',
    ]);
    // `created` remonte au client pour qu'il n'affiche pas « créée » à tort.
    expect(out.created).toBe(true);
    expect(out._id).toBe('uuid-new');
  });

  it('n’émet RIEN sur un doublon, et renvoie created:false', async () => {
    const doc = { _id: 'uuid-old', category: 'Carte mère' };
    const { resolver, emit } = makeResolver({ doc, created: false });

    const out = await resolver.createDiCategory('carte mere', profile);

    expect(emit).not.toHaveBeenCalled();
    expect(out.created).toBe(false);
    expect(out._id).toBe('uuid-old');
  });

  it('garde la création acquise si la notification échoue (best-effort)', async () => {
    const doc = { _id: 'uuid-new', category: 'Carte mère' };
    const { resolver, emit } = makeResolver({ doc, created: true });
    emit.mockRejectedValueOnce(new Error('socket down'));

    const out = await resolver.createDiCategory('Carte mère', profile);

    expect(out._id).toBe('uuid-new');
    expect(out.created).toBe(true);
    expect(resolver.logger.warn).toHaveBeenCalled();
  });

  it('tolère un acteur non résolu sans inventer d’auteur', async () => {
    const doc = { _id: 'uuid-new', category: 'Divers' };
    const { resolver, emit } = makeResolver({ doc, created: true });

    await resolver.createDiCategory('Divers', undefined);

    expect(emit.mock.calls[0][0].actorId).toBeNull();
    expect(emit.mock.calls[0][0].actorRole).toBeNull();
  });
});
