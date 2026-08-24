import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';

/**
 * MATRICE DE CYCLE DE VIE — sortie de diagnostic, TOUTES combinaisons.
 * Réparable / non réparable × PDR / sans PDR × payant / non payant × flux
 * ORIGINAL (ignoreCount=0) / RETOUR (ignoreCount>0) × verdict « erreur
 * Fixtronix » en retour. Test auto-suffisant au niveau API : seed direct
 * (DI + Stat + LogsDi de cycle pour le retour), appel de la MÊME mutation que
 * le front, assertion sur le statut obtenu. Nettoyage exhaustif en fin.
 *
 * Le routage a été cartographié end-to-end (front handler → mutation → service).
 * En RETOUR, le routage lit le SNAPSHOT DU CYCLE (LogsDi {_idDi, idIgnore}),
 * pas la DI vive — d'où le seed d'un LogsDi pour les cas 6-9.
 */

const P = 'di-lcm-e2e-'; // prefix
const ALL: string[] = [];

async function seed(opts: {
  key: string;
  ignoreCount?: number;
  can_be_repaired: boolean;
  contain_pdr?: boolean;
  diagnosticPayant?: boolean;
  composants?: boolean;
  log?: { contain_pdr: boolean; composants: boolean; fixtronix: boolean };
}): Promise<string> {
  const _id = P + opts.key;
  ALL.push(_id);
  const ignoreCount = opts.ignoreCount ?? 0;
  const comps = opts.composants ? [{ nameComposant: 'Fusible', quantity: 1 }] : [];
  await withDb(async (db) => {
    await db.collection('dis').deleteOne({ _id });
    await db.collection('stats').deleteMany({ _idDi: _id });
    await db.collection('logsdis').deleteMany({ _idDi: _id });
    const now = new Date();
    await db.collection('dis').insertOne({
      _id,
      _idnum: _id,
      title: 'LIFECYCLE MATRIX E2E',
      status: 'INDIAGNOSTIC',
      ignoreCount,
      can_be_repaired: opts.can_be_repaired,
      contain_pdr: opts.contain_pdr ?? false,
      array_composants: comps,
      ...(opts.diagnosticPayant !== undefined
        ? { diagnosticPayant: opts.diagnosticPayant }
        : {}),
      current_roles: [],
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('stats').insertOne({
      _id: `stat-${_id}`,
      _idDi: _id,
      ignoreCount,
      status: 'INDIAGNOSTIC',
      createdAt: now,
      updatedAt: now,
    });
    // Snapshot LogsDi du cycle courant (routage RETOUR le lit).
    if (opts.log) {
      await db.collection('logsdis').insertOne({
        _id: `log-${_id}`,
        _idDi: _id,
        idIgnore: ignoreCount,
        contain_pdr: opts.log.contain_pdr,
        array_composants: opts.log.composants
          ? [{ nameComposant: 'Fusible', quantity: 1 }]
          : [],
        isErrorFromFixtronix: opts.log.fixtronix,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  return _id;
}

async function statusOf(_id: string): Promise<string | undefined> {
  return withDb(async (db) => {
    const di = await db.collection('dis').findOne({ _id }, { projection: { status: 1 } });
    return di?.status;
  });
}

const toFinish = (id: string) =>
  `mutation { changestatusToFinishReparation(_id: "${id}") { _id status } }`;
const magasinEstim = (id: string) =>
  `mutation { changeStatusMagasinEstimation(_id: "${id}") }`;
const pending2 = (id: string) => `mutation { changeStatusPending2(_id: "${id}") }`;

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.collection('dis').deleteMany({ _id: { $in: ALL } });
    await db.collection('stats').deleteMany({ _idDi: { $in: ALL } });
    await db.collection('logsdis').deleteMany({ _idDi: { $in: ALL } });
    await db.collection('notifications').deleteMany({ diId: { $in: ALL } });
    await db.collection('system_events').deleteMany({ diId: { $in: ALL } });
  });
});

// ───────────────────────── FLUX ORIGINAL (ignoreCount=0) ─────────────────────
test('01 · ORIGINAL · non réparable · PAYANT → PENDING2 (facturer le diagnostic)', async ({ request }) => {
  const id = await seed({ key: 'o-nr-pay', can_be_repaired: false, diagnosticPayant: true });
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING2');
});

test('02 · ORIGINAL · non réparable · NON PAYANT → IRREPARABLE (direct, sans facturation)', async ({ request }) => {
  const id = await seed({ key: 'o-nr-nonpay', can_be_repaired: false, diagnosticPayant: false });
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('IRREPARABLE');
});

test('03 · ORIGINAL · réparable · AVEC PDR → MagasinEstimation', async ({ request }) => {
  const id = await seed({ key: 'o-rep-pdr', can_be_repaired: true, contain_pdr: true, composants: true });
  const r = await gqlPost(request, magasinEstim(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('MagasinEstimation');
});

test('04 · ORIGINAL · réparable · SANS PDR → PENDING2', async ({ request }) => {
  const id = await seed({ key: 'o-rep-nopdr', can_be_repaired: true, contain_pdr: false });
  const r = await gqlPost(request, pending2(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING2');
});

// ───────────────────────── FLUX RETOUR (ignoreCount>0) ───────────────────────
test('05 · RETOUR · non réparable → IRREPARABLE (aucune facturation en retour)', async ({ request }) => {
  const id = await seed({ key: 'r-nr', ignoreCount: 1, can_be_repaired: false });
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('IRREPARABLE');
});

test('06 · RETOUR · réparable · SANS PDR · Fixtronix=OUI (« Envoyer vers finir ») → PENDING3 (non facturé)', async ({ request }) => {
  const id = await seed({
    key: 'r-rep-nopdr-fix', ignoreCount: 1, can_be_repaired: true, contain_pdr: false,
    log: { contain_pdr: false, composants: false, fixtronix: true },
  });
  // CORRIGÉ : « Envoyer vers finir » → changestatusToFinishReparation →
  // changeStatusTofinsh lit le snapshot du cycle (Fixtronix + sans PDR + sans
  // pièce) → PENDING3 (envoi en réparation sans facturation). Aligné au flowchart.
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING3');
});

test('07 · RETOUR · réparable · AVEC PDR → MagasinEstimation', async ({ request }) => {
  const id = await seed({
    key: 'r-rep-pdr', ignoreCount: 1, can_be_repaired: true, contain_pdr: true, composants: true,
    log: { contain_pdr: true, composants: true, fixtronix: false },
  });
  const r = await gqlPost(request, magasinEstim(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('MagasinEstimation');
});

test('08 · RETOUR · réparable · SANS PDR · Fixtronix=NON → PENDING2', async ({ request }) => {
  const id = await seed({
    key: 'r-rep-nopdr-nofix', ignoreCount: 1, can_be_repaired: true, contain_pdr: false,
    log: { contain_pdr: false, composants: false, fixtronix: false },
  });
  const r = await gqlPost(request, pending2(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING2');
});

test('09 · RETOUR · SANS PDR · Fixtronix=OUI · appel API DIRECT changeStatusMagasinEstimation → PENDING3 (raccourci)', async ({ request }) => {
  const id = await seed({
    key: 'r-shortcut', ignoreCount: 1, can_be_repaired: true, contain_pdr: false,
    log: { contain_pdr: false, composants: false, fixtronix: true },
  });
  // Raccourci « retour sans PDR + Fixtronix → PENDING3 » — atteignable UNIQUEMENT
  // par appel direct à changeStatusMagasinEstimation (le chemin UI produit IRREPARABLE, cf. cas 06).
  const r = await gqlPost(request, magasinEstim(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('PENDING3');
});

test('10 · RETOUR · Fixtronix=OUI · composants consommés · IRRÉPARABLE → IRREPARABLE, AUCUNE facturation', async ({ request }) => {
  const id = await seed({
    key: 'r-fix-comp-irr', ignoreCount: 1, can_be_repaired: false, contain_pdr: true, composants: true,
    log: { contain_pdr: true, composants: true, fixtronix: true },
  });
  // Erreur Fixtronix (notre faute) + pièces consommées + irréparable → on ne
  // facture RIEN, la DI est simplement IRREPARABLE.
  const r = await gqlPost(request, toFinish(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await statusOf(id)).toBe('IRREPARABLE');
  // Aucune facturation : ni price ni final_price positifs.
  const di = await withDb((db) =>
    db.collection('dis').findOne({ _id: id }, { projection: { price: 1, final_price: 1 } }),
  );
  expect(Number(di?.price ?? 0)).toBe(0);
  expect(Number(di?.final_price ?? 0)).toBe(0);
});
