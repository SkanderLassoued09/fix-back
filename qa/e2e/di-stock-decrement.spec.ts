import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';

/**
 * Item 2 — décrément de stock quand le magasin envoie la liste des composants.
 * VALIDE le fix : les pièces taguées 'Externe'/'Interne' (et plus seulement
 * 'En stock') sont bien décrémentées, et une pièce introuvable ne marque PAS à
 * tort la DI comme décrémentée (verrou relâché → rattrapable).
 * Seed direct au niveau API, appel de la vraie mutation, assertion sur le
 * catalogue `composants`. Nettoyage exhaustif en fin.
 */

const TAG = 'stockdec-e2e';
const PART_EXT = `${TAG}-externe`;
const PART_MISS = `${TAG}-missing`;
const ALL_DIS: string[] = [];
const ALL_CMP: string[] = [`CMP_${TAG}_ext`];

async function seedDi(opts: {
  key: string;
  nameComposant: string;
  qty: number;
}): Promise<string> {
  const _id = `DI_${TAG}_${opts.key}`;
  ALL_DIS.push(_id);
  await withDb(async (db) => {
    const now = new Date();
    await db.collection('dis').deleteOne({ _id });
    await db.collection('stats').deleteMany({ _idDi: _id });
    await db.collection('dis').insertOne({
      _id,
      _idnum: _id,
      title: 'STOCK DECREMENT E2E',
      status: 'CONFIRMATION', // = clé TS InMagasin (source du handshake)
      ignoreCount: 0,
      contain_pdr: true,
      array_composants: [{ nameComposant: opts.nameComposant, quantity: opts.qty }],
      stockDecrementedAt: null,
      current_roles: ['Magasin'],
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('stats').insertOne({
      _id: `stat-${_id}`,
      _idDi: _id,
      ignoreCount: 0,
      status: 'CONFIRMATION',
      createdAt: now,
      updatedAt: now,
    });
  });
  return _id;
}

test.beforeAll(async () => {
  await withDb(async (db) => {
    const now = new Date();
    // Pièce catalogue taguée 'Externe' — AVANT le fix elle n'était jamais
    // décrémentée (filtre limité à 'En stock'/'EnStock').
    await db.collection('composants').deleteOne({ _id: `CMP_${TAG}_ext` });
    await db.collection('composants').insertOne({
      _id: `CMP_${TAG}_ext`,
      name: PART_EXT,
      status_composant: 'Externe',
      quantity_stocked: 10,
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    });
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.collection('dis').deleteMany({ _id: { $in: ALL_DIS } });
    await db.collection('stats').deleteMany({ _idDi: { $in: ALL_DIS } });
    await db.collection('composants').deleteMany({ _id: { $in: ALL_CMP } });
    await db.collection('notifications').deleteMany({ diId: { $in: ALL_DIS } });
    await db.collection('system_events').deleteMany({ diId: { $in: ALL_DIS } });
  });
});

const sendList = (id: string) =>
  `mutation { sendComponentToConMagasinForConfirmation(_id: "${id}") { _id status } }`;

async function qtyOf(name: string): Promise<number | undefined> {
  return withDb(async (db) => {
    const c = await db
      .collection('composants')
      .findOne({ name }, { projection: { quantity_stocked: 1 } });
    return c?.quantity_stocked;
  });
}

async function stampOf(id: string): Promise<any> {
  return withDb(async (db) => {
    const d = await db
      .collection('dis')
      .findOne({ _id: id }, { projection: { stockDecrementedAt: 1 } });
    return d?.stockDecrementedAt ?? null;
  });
}

test('Externe part IS decremented on magasin send (10 − 3 = 7)', async ({ request }) => {
  const id = await seedDi({ key: 'ext', nameComposant: PART_EXT, qty: 3 });
  expect(await qtyOf(PART_EXT)).toBe(10);
  const r = await gqlPost(request, sendList(id));
  expect(r.errors, r.errorText).toBeNull();
  expect(await qtyOf(PART_EXT)).toBe(7);
  // Décrément réellement engagé → DI marquée.
  expect(await stampOf(id)).not.toBeNull();
});

test('Unknown part name does NOT falsely stamp the DI (lock released for retry)', async ({ request }) => {
  const id = await seedDi({ key: 'miss', nameComposant: PART_MISS, qty: 2 });
  const r = await gqlPost(request, sendList(id));
  expect(r.errors, r.errorText).toBeNull();
  // Rien n'a matché → le verrou est relâché (stockDecrementedAt remis à null),
  // au lieu de marquer faussement la DI comme décrémentée.
  expect(await stampOf(id)).toBeNull();
});
