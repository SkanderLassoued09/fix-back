import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';

/**
 * PRIX RÉPARATION (cas NON PAYANT) — calcul serveur-autoritaire :
 *   final_price = prix_réparation + diagLabour + composantsCost
 *   diagLabour     = heures_diag × tarif_horaire
 *   composantsCost = Σ(prix_vente × quantité)
 *
 * Déterministe : on FIXE le tarif horaire (50) et le prix d'une pièce de test
 * (30) le temps du test, puis on restaure l'état d'origine. Seed direct
 * (DI non payante + Stat.diag_time + pièces), appel de la vraie mutation
 * setRepairFinalPrice, assertions montant par montant.
 */

const DI1 = 'di-pf-e2e-1';
const DI2 = 'di-pf-e2e-2';
const COMP = 'DI-PF-COMP-TEST';
const TARIF = 50; // TND / heure
const PRIX_VENTE = 30; // TND / pièce

let savedTarifs: any[] = [];

test.beforeAll(async () => {
  await withDb(async (db) => {
    // Fixe le tarif horaire, en sauvegardant l'existant.
    savedTarifs = await db.collection('tarifs').find({}).toArray();
    await db.collection('tarifs').deleteMany({});
    await db.collection('tarifs').insertOne({ tarif: TARIF });
    // Pièce catalogue de test.
    await db.collection('composants').deleteMany({ name: COMP });
    await db.collection('composants').insertOne({
      _id: 'comp-' + COMP,
      name: COMP,
      prix_vente: PRIX_VENTE,
      prix_achat: 10,
      quantity_stocked: 100,
    });
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    // Restaure le tarif d'origine.
    await db.collection('tarifs').deleteMany({});
    if (savedTarifs.length) await db.collection('tarifs').insertMany(savedTarifs);
    await db.collection('composants').deleteMany({ name: COMP });
    await db.collection('dis').deleteMany({ _id: { $in: [DI1, DI2] } });
    await db.collection('stats').deleteMany({ _idDi: { $in: [DI1, DI2] } });
    await db.collection('logsdis').deleteMany({ _idDi: { $in: [DI1, DI2] } });
  });
});

async function seed(_id: string, diagTime: string, qty: number) {
  await withDb(async (db) => {
    const now = new Date();
    await db.collection('dis').deleteOne({ _id });
    await db.collection('stats').deleteMany({ _idDi: _id });
    await db.collection('dis').insertOne({
      _id,
      _idnum: _id,
      title: 'PRICING FORMULA E2E',
      status: 'PRICING_DIAG',
      ignoreCount: 0,
      can_be_repaired: true,
      contain_pdr: qty > 0,
      diagnosticPayant: false, // NON PAYANT
      array_composants: qty > 0 ? [{ nameComposant: COMP, quantity: qty }] : [],
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('stats').insertOne({
      _id: 'stat-' + _id,
      _idDi: _id,
      ignoreCount: 0,
      status: 'PRICING_DIAG',
      diag_time: diagTime,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function diMoney(_id: string) {
  return withDb(async (db) =>
    db.collection('dis').findOne({ _id }, { projection: { price: 1, final_price: 1, repairEstimate: 1 } }),
  );
}

test('non payant : final = prix_réparation + diagLabour(2h×50) + pièces(2×30)', async ({ request }) => {
  await seed(DI1, '02:00:00', 2); // 2h de diag, 2 pièces
  const r = await gqlPost(
    request,
    `mutation { setRepairFinalPrice(_id: "${DI1}", repairPrice: 150) { repairPrice diagLabour componentsCost final_price } }`,
  );
  expect(r.errors, r.errorText).toBeNull();
  const b = r.data.setRepairFinalPrice;
  expect(b.repairPrice).toBe(150);
  expect(b.diagLabour).toBe(100); // 2h × 50
  expect(b.componentsCost).toBe(60); // 2 × 30
  expect(b.final_price).toBe(310); // 150 + 100 + 60
  // Persistance : price=0 (diag non facturé), final_price = total.
  const di = await diMoney(DI1);
  expect(di?.price).toBe(0);
  expect(di?.final_price).toBe(310);
  expect(di?.repairEstimate).toBe(150);
});

test('non payant : prix_réparation = 0 → final = diagLabour + pièces (1h30 × 50 + 1×30)', async ({ request }) => {
  await seed(DI2, '01:30:00', 1); // 1.5h de diag, 1 pièce
  const r = await gqlPost(
    request,
    `mutation { setRepairFinalPrice(_id: "${DI2}", repairPrice: 0) { diagLabour componentsCost final_price } }`,
  );
  expect(r.errors, r.errorText).toBeNull();
  const b = r.data.setRepairFinalPrice;
  expect(b.diagLabour).toBe(75); // 1.5h × 50
  expect(b.componentsCost).toBe(30); // 1 × 30
  expect(b.final_price).toBe(105); // 0 + 75 + 30
  expect((await diMoney(DI2))?.final_price).toBe(105);
});
