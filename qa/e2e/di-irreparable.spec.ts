import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';

/**
 * feat IRREPARABLE — validation end-to-end du nouveau statut TERMINAL
 * « IRREPARABLE » et de son routage server-authoritative. Test AUTO-SUFFISANT :
 * il seed chaque scénario directement en base (au bon statut de diagnostic),
 * déclenche la transition par l'API GraphQL réelle, puis vérifie le statut
 * obtenu. Il CONTOURNE volontairement le pilotage UI complet (create → affecter
 * → démarrer diag) qui, dans la suite existante, bute sur la garde d'ownership
 * technicien (« affectée à un autre technicien ») — un décalage test/back
 * pré-existant, sans rapport avec IRREPARABLE.
 *
 * Règles validées (miroir de di.diagnostic-routing.spec.ts, mais via l'API) :
 *   - non payant + non réparable (flux original) → IRREPARABLE direct
 *   - payant  + non réparable (flux original) → PENDING2 (facturation d'abord)
 *   - PRICING_DIAG (payant, non réparable) → « Valider le prix » → IRREPARABLE
 *   - retour (ignoreCount>0) + non réparable → IRREPARABLE (aucune facturation)
 *   - GARDE : IRREPARABLE-depuis-pricing REFUSÉ si la DI est réparable
 *
 * Nettoyage exhaustif en fin de suite (dis + stats + notifications +
 * system_events + logsdis) pour ne laisser aucune donnée de test en base.
 */

const IDS = {
  nonPayant: 'di-irrep-e2e-nonpayant',
  payant: 'di-irrep-e2e-payant',
  pricing: 'di-irrep-e2e-pricing',
  retour: 'di-irrep-e2e-retour',
  reparableGuard: 'di-irrep-e2e-reparable-guard',
};
const ALL_IDS = Object.values(IDS);

async function seedDi(patch: {
  _id: string;
  status: string;
  ignoreCount?: number;
  diagnosticPayant?: boolean;
  can_be_repaired?: boolean;
}): Promise<void> {
  await withDb(async (db) => {
    const ignoreCount = patch.ignoreCount ?? 0;
    await db.collection('dis').deleteOne({ _id: patch._id });
    await db.collection('stats').deleteMany({ _idDi: patch._id });
    const now = new Date();
    await db.collection('dis').insertOne({
      _id: patch._id,
      _idnum: patch._id,
      title: 'IRREPARABLE E2E — donnée de test',
      status: patch.status,
      ignoreCount,
      diagnosticPayant: patch.diagnosticPayant,
      can_be_repaired: patch.can_be_repaired,
      current_roles: [],
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    });
    // Le back met à jour un Stat par `{ _idDi [, ignoreCount] }` à chaque
    // transition (statsService.updateStatus) : sans cette ligne, il lève
    // « Issue in changing stats stattus ». Le vrai flux la crée à l'affectation.
    await db.collection('stats').insertOne({
      _id: `stat-${patch._id}`,
      _idDi: patch._id,
      ignoreCount,
      status: patch.status,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function statusOf(_id: string): Promise<string | undefined> {
  return withDb(async (db) => {
    const di = await db
      .collection('dis')
      .findOne({ _id }, { projection: { status: 1 } });
    return di?.status;
  });
}

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.collection('dis').deleteMany({ _id: { $in: ALL_IDS } });
    await db.collection('stats').deleteMany({ _idDi: { $in: ALL_IDS } });
    await db.collection('notifications').deleteMany({ diId: { $in: ALL_IDS } });
    await db.collection('system_events').deleteMany({ diId: { $in: ALL_IDS } });
    await db.collection('logsdis').deleteMany({ _idDi: { $in: ALL_IDS } });
  });
});

test('non payant + non réparable (flux original) → IRREPARABLE direct', async ({
  request,
}) => {
  const _id = IDS.nonPayant;
  await seedDi({
    _id,
    status: 'INDIAGNOSTIC',
    ignoreCount: 0,
    diagnosticPayant: false,
    can_be_repaired: false,
  });

  const r = await gqlPost(
    request,
    `mutation { changestatusToFinishReparation(_id: "${_id}") { _id status } }`,
  );
  expect(r.errors, r.errorText).toBeNull();
  // Clôture directe, aucune facturation.
  expect(await statusOf(_id)).toBe('IRREPARABLE');
});

test('payant + non réparable (flux original) → PENDING2 (facturer d’abord, pas de clôture)', async ({
  request,
}) => {
  const _id = IDS.payant;
  await seedDi({
    _id,
    status: 'INDIAGNOSTIC',
    ignoreCount: 0,
    diagnosticPayant: true,
    can_be_repaired: false,
  });

  const r = await gqlPost(
    request,
    `mutation { changestatusToFinishReparation(_id: "${_id}") { _id status } }`,
  );
  expect(r.errors, r.errorText).toBeNull();
  // Le diagnostic payant doit être facturé AVANT toute clôture → PENDING2.
  expect(await statusOf(_id)).toBe('PENDING2');
});

test('PRICING_DIAG (payant, non réparable) → « Valider le prix » clôture en IRREPARABLE', async ({
  request,
}) => {
  const _id = IDS.pricing;
  await seedDi({
    _id,
    status: 'PRICING_DIAG',
    ignoreCount: 0,
    diagnosticPayant: true,
    can_be_repaired: false,
  });

  const r = await gqlPost(
    request,
    `mutation { changeStatusIrreparableFromPricing(_id: "${_id}") }`,
  );
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(_id)).toBe('IRREPARABLE');
});

test('retour (ignoreCount>0) + non réparable → IRREPARABLE (aucune facturation en retour)', async ({
  request,
}) => {
  const _id = IDS.retour;
  await seedDi({
    _id,
    status: 'INDIAGNOSTIC',
    ignoreCount: 1,
    diagnosticPayant: true, // même payant : en retour, pas de re-facturation
    can_be_repaired: false,
  });

  const r = await gqlPost(
    request,
    `mutation { changestatusToFinishReparation(_id: "${_id}") { _id status } }`,
  );
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(_id)).toBe('IRREPARABLE');
});

test('GARDE : clôture IRREPARABLE-depuis-pricing REFUSÉE si la DI est réparable', async ({
  request,
}) => {
  const _id = IDS.reparableGuard;
  await seedDi({
    _id,
    status: 'PRICING_DIAG',
    ignoreCount: 0,
    diagnosticPayant: true,
    can_be_repaired: true, // réparable → ne doit PAS pouvoir clôturer en irréparable
  });

  const r = await gqlPost(
    request,
    `mutation { changeStatusIrreparableFromPricing(_id: "${_id}") }`,
  );
  // Refus métier explicite.
  expect(r.errors, 'attendu : refus GraphQL').not.toBeNull();
  expect(r.errorText).toMatch(/réparable/);
  // Statut inchangé (pas de clôture).
  expect(await statusOf(_id)).toBe('PRICING_DIAG');
});
