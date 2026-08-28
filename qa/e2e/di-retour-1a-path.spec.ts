import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';
import { tokenFor } from '../utils/auth';

/**
 * FT-04 (cas 1A) : un RETOUR Fixtronix + AVEC PDR + réparable doit finir
 * « Magasin → PENDING3 », SANS jamais passer par PENDING2/Pricing — une erreur
 * Fixtronix (notre faute) n'est jamais facturée au client. Le cas 11 de la
 * matrice ne prouve que l'ENTRÉE au magasin (MagasinEstimation).
 *
 * La sortie magasin partait auparavant en PENDING2 → PRICING_DIAG (facturée) ;
 * elle est désormais détournée vers la poignée de main composants. On pousse la
 * DI jusqu'au bout, on journalise le statut à chaque étape, et on assert que
 * AUCUN statut de facturation n'a été touché.
 */

const ID = 'DI_retour1a-path-e2e';

test.beforeAll(async () => {
  await withDb(async (db) => {
    const now = new Date();
    await db.collection('dis').deleteOne({ _id: ID });
    await db.collection('stats').deleteMany({ _idDi: ID });
    await db.collection('logsdis').deleteMany({ _idDi: ID });
    const comps = [{ nameComposant: 'Fusible', quantity: 1 }];
    await db.collection('dis').insertOne({
      _id: ID,
      _idnum: ID,
      title: 'RETOUR 1A PATH',
      status: 'INDIAGNOSTIC',
      ignoreCount: 1,
      can_be_repaired: true,
      contain_pdr: true,
      array_composants: comps,
      current_roles: [],
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('stats').insertOne({
      _id: `stat-${ID}`, _idDi: ID, ignoreCount: 1, status: 'INDIAGNOSTIC',
      createdAt: now, updatedAt: now,
    });
    await db.collection('logsdis').insertOne({
      _id: `log-${ID}`, _idDi: ID, idIgnore: 1,
      can_be_repaired: true, contain_pdr: true,
      array_composants: comps, isErrorFromFixtronix: true,
      createdAt: now, updatedAt: now,
    });
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.collection('dis').deleteMany({ _id: ID });
    await db.collection('stats').deleteMany({ _idDi: ID });
    await db.collection('logsdis').deleteMany({ _idDi: ID });
    await db.collection('notifications').deleteMany({ diId: ID });
    await db.collection('system_events').deleteMany({ diId: ID });
  });
});

async function statusOf(): Promise<string | undefined> {
  return withDb(async (db) => {
    const di = await db.collection('dis').findOne({ _id: ID }, { projection: { status: 1 } });
    return di?.status;
  });
}

test('1A : retour Fixtronix+PDR+réparable atteint bien PENDING3 (via Magasin → poignée de main composants)', async ({ request }) => {
  const M = (op: string) => `mutation { ${op} }`;
  // Route Fixtronix : la sortie magasin (`magasinTech_Pending2`) est DÉTOURNÉE
  // vers la poignée de main composants (CONFIRMATION), en sautant PENDING2 et
  // toute la phase tarification/approbation. Séquence serveur-autoritaire
  // complète jusqu'à PENDING3.
  // NB : en RETOUR, les deux étapes de la poignée de main écrivent le LOG du
  // cycle et non `di.status` — la DI reste donc en CONFIRMATION jusqu'à
  // « Fin liste composants » (`changeStatusPending3`).
  const token = tokenFor('ADMIN_MANAGER'); // componentConfirmedFromCoordinator = JwtAuthGuard
  const steps: Array<[string, string, string]> = [
    ['changeStatusMagasinEstimation', M(`changeStatusMagasinEstimation(_id: "${ID}")`), 'MagasinEstimation'],
    ['magasinTech_Pending2 (sortie magasin, détournée)', M(`magasinTech_Pending2(_id: "${ID}") { _id status }`), 'CONFIRMATION'],
    ['sendComponentToConMagasinForConfirmation', M(`sendComponentToConMagasinForConfirmation(_id: "${ID}") { _id status }`), 'CONFIRMATION'],
    ['componentConfirmedFromCoordinator', M(`componentConfirmedFromCoordinator(_id: "${ID}") { _id status }`), 'CONFIRMATION'],
    ['changeStatusPending3', M(`changeStatusPending3(_id: "${ID}")`), 'PENDING3'],
  ];

  const trail: string[] = [];
  trail.push(`start: ${await statusOf()}`);
  for (const [label, mut, expected] of steps) {
    const r = await gqlPost(request, mut, token);
    const err = r.errors?.[0]?.message ?? '';
    const st = await statusOf();
    trail.push(`${label} → status=${st} (attendu ${expected})${err ? ` [ERR: ${err}]` : ''}`);
    // Chaque étape de la route Fixtronix doit passer proprement : un refus de
    // transition ici signifierait que le détour a cassé le chemin composants.
    expect(err, `${label} : ${err}`).toBe('');
    expect(st, `${label} : statut inattendu`).toBe(expected);
  }
  console.log('\n──── RETOUR 1A PATH TRAIL ────\n' + trail.join('\n') + '\n');
  const finalStatus = await statusOf();
  console.log('FINAL:', finalStatus);

  // 1A COMPLET : la DI atteint réellement PENDING3 (envoi en réparation) après
  // le magasin + la poignée de main composants. Pas de lacune : le chemin existe.
  expect(finalStatus, 'retour PDR réparable doit atteindre PENDING3').toBe('PENDING3');

  // LA règle argent : une erreur Fixtronix ne touche AUCUN statut de facturation.
  const di: any = await withDb((db) => db.collection('dis').findOne({ _id: ID }));
  const visited = [
    ...(di?.statusHistory ?? []).map((h: any) => String(h?.status)),
    String(di?.status),
  ];
  for (const billing of ['PENDING2', 'PRICING_DIAG', 'PRICING']) {
    expect(visited, `erreur Fixtronix passée par ${billing} : ${visited.join(' → ')}`)
      .not.toContain(billing);
  }
  // Le devis coordinatrice reste obligatoire avant l'envoi en réparation.
  expect(di?.needsDevisBeforeRepair).toBe(true);
});
