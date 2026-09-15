import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';
import { tokenFor } from '../utils/auth';

/**
 * FT-04 (cas 1A) : un RETOUR Fixtronix + AVEC PDR + réparable passe par le
 * magasin PUIS la tarification (règle du 2026-09-15), comme un retour client.
 * En Pricing, la bascule « Facturer le diagnostic ? » décide ce qui est facturé.
 *
 * Avant, la sortie magasin était détournée vers la poignée de main composants
 * (CONFIRMATION → … → PENDING3) en sautant la tarification. On pousse la DI
 * jusqu'en tarification, on journalise chaque étape et on assert le chemin.
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

test('1A : retour Fixtronix+PDR+réparable → Magasin → PENDING2 → tarification', async ({ request }) => {
  const M = (op: string) => `mutation { ${op} }`;
  const token = tokenFor('ADMIN_MANAGER');
  const steps: Array<[string, string, string]> = [
    ['changeStatusMagasinEstimation', M(`changeStatusMagasinEstimation(_id: "${ID}")`), 'MagasinEstimation'],
    ['magasinTech_Pending2 (sortie magasin)', M(`magasinTech_Pending2(_id: "${ID}") { _id status }`), 'PENDING2'],
    ['changeStatusPricing', M(`changeStatusPricing(_id: "${ID}")`), 'PRICING_DIAG'],
  ];

  const trail: string[] = [];
  trail.push(`start: ${await statusOf()}`);
  for (const [label, mut, expected] of steps) {
    const r = await gqlPost(request, mut, token);
    const err = r.errors?.[0]?.message ?? '';
    const st = await statusOf();
    trail.push(`${label} → status=${st} (attendu ${expected})${err ? ` [ERR: ${err}]` : ''}`);
    expect(err, `${label} : ${err}`).toBe('');
    expect(st, `${label} : statut inattendu`).toBe(expected);
  }
  console.log('\n──── RETOUR 1A PATH TRAIL ────\n' + trail.join('\n') + '\n');

  const di: any = await withDb((db) => db.collection('dis').findOne({ _id: ID }));
  const visited = [
    ...(di?.statusHistory ?? []).map((h: any) => String(h?.status)),
    String(di?.status),
  ];
  // Plus de raccourci : ni poignée de main anticipée ni PENDING3 avant tarification.
  for (const shortcut of ['CONFIRMATION', 'PENDING3']) {
    expect(visited, `raccourci ${shortcut} : ${visited.join(' → ')}`).not.toContain(shortcut);
  }
  expect(di?.needsDevisBeforeRepair).not.toBe(true);
});
