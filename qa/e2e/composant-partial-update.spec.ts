import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { getAuthToken, gql } from './_helpers';

/**
 * Composant « Enregistrer » — PARTIAL update + rename cascade (API contract).
 *
 * Locks the regression where saving one field wiped the others / emptied the
 * modal on reopen:
 *  - a field that isn't (meaningfully) sent keeps its stored value;
 *  - `pdf` is never re-nulled when no new file is uploaded;
 *  - renaming the part cascades onto every DI's `array_composants[].nameComposant`
 *    (parts are linked by name), so reopening still resolves the row.
 *
 * The end-to-end modal flow lives in composant-partial-update.ui.spec.ts.
 */

const TAG = Date.now().toString(36);

const SAVE = `mutation($i: CreateComposantInput!){
  addComposantInfo(updateComposant:$i){ _id name }
}`;
const READ = `query($name:String!){
  findOneComposant(name:$name){
    _id name package category_composant_id prix_achat prix_vente
    coming_date link quantity_stocked pdf status_composant
  }
}`;

const ORIG = (id: string, name: string) => ({
    _id: id,
    name,
    package: 'PKG-ORIG',
    category_composant_id: 'CAT-ORIG',
    prix_achat: 11.5,
    prix_vente: 22.5,
    coming_date: '2026-06-10',
    link: 'http://parts.tn/orig',
    quantity_stocked: 77,
    pdf: 'datasheet-orig.pdf',
    status_composant: 'En stock',
    isDeleted: false,
});

async function seedComposant(id: string, name: string) {
    await withDb(async (db) => {
        await db
            .collection('composants')
            .insertOne({ ...ORIG(id, name), createdAt: new Date(), updatedAt: new Date() });
    });
}

function stripMeta(o: any) {
    const { isDeleted, ...rest } = o;
    return rest;
}

test.afterAll(async () => {
    await withDb(async (db) => {
        await db
            .collection('composants')
            .deleteMany({ name: { $regex: `${TAG}` } });
        await db.collection('dis').deleteMany({
            $or: [
                { _id: { $regex: `${TAG}` } },
                { _idnum: { $regex: `${TAG}` } },
            ],
        });
    });
});

test('editing ONE field leaves every other field intact (full payload)', async ({
    request,
}) => {
    const token = await getAuthToken(request);
    const id = `Cmp_pu_a_${TAG}`;
    const name = `QA PU A ${TAG}`;
    await seedComposant(id, name);

    // The front sends the whole form; change only `package`.
    const input = { ...stripMeta(ORIG(id, name)), package: 'PKG-NEW' };
    const r = await gql(request, token, SAVE, { i: input });
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(0);

    const read = await gql(request, token, READ, { name });
    const doc = read.data?.findOneComposant;
    expect(doc.package).toBe('PKG-NEW'); // changed
    expect(doc.prix_achat).toBe(11.5); // intact
    expect(doc.prix_vente).toBe(22.5);
    expect(doc.quantity_stocked).toBe(77); // not 0 / Rupture
    expect(doc.category_composant_id).toBe('CAT-ORIG');
    expect(doc.link).toBe('http://parts.tn/orig');
    expect(doc.status_composant).toBe('En stock');
    expect(doc.pdf).toBe('datasheet-orig.pdf'); // datasheet kept
    expect(doc.coming_date).toBe('2026-06-10');
});

test('a truly partial payload preserves the omitted fields', async ({
    request,
}) => {
    const token = await getAuthToken(request);
    const id = `Cmp_pu_b_${TAG}`;
    const name = `QA PU B ${TAG}`;
    await seedComposant(id, name);

    // Only _id + name + one field — everything omitted must stay.
    const r = await gql(request, token, SAVE, {
        i: { _id: id, name, link: 'http://parts.tn/new' },
    });
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(0);

    const doc = (await gql(request, token, READ, { name })).data?.findOneComposant;
    expect(doc.link).toBe('http://parts.tn/new'); // changed
    expect(doc.package).toBe('PKG-ORIG'); // preserved
    expect(doc.prix_achat).toBe(11.5);
    expect(doc.quantity_stocked).toBe(77);
    expect(doc.pdf).toBe('datasheet-orig.pdf');
});

test('empty/zero handling: "" is ignored, 0 is written', async ({ request }) => {
    const token = await getAuthToken(request);
    const id = `Cmp_pu_c_${TAG}`;
    const name = `QA PU C ${TAG}`;
    await seedComposant(id, name);

    // package "" → ignored (kept); quantity 0 → written (real Rupture).
    const r = await gql(request, token, SAVE, {
        i: { _id: id, name, package: '', quantity_stocked: 0 },
    });
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(0);
    const doc = (await gql(request, token, READ, { name })).data?.findOneComposant;
    expect(doc.package).toBe('PKG-ORIG'); // "" did not wipe it
    expect(doc.quantity_stocked).toBe(0); // 0 is a deliberate value
});

test('renaming cascades onto the DI array_composants linkage', async ({
    request,
}) => {
    const token = await getAuthToken(request);
    const id = `Cmp_pu_d_${TAG}`;
    const name = `QA PU D ${TAG}`;
    const newName = `${name} v2`;
    const diId = `DI_pu_${TAG}`;
    await seedComposant(id, name);
    await withDb(async (db) => {
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: `PU-${TAG}`,
            contain_pdr: true,
            status: 'MagasinEstimation',
            isDeleted: false,
            array_composants: [
                { nameComposant: name, quantity: 3, isUpdated: false },
            ],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });

    const r = await gql(request, token, SAVE, {
        i: { ...stripMeta(ORIG(id, name)), name: newName },
    });
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(0);

    await withDb(async (db) => {
        const di = await db.collection('dis').findOne({ _id: diId });
        expect(di.array_composants[0].nameComposant).toBe(newName);
    });
    // The renamed part resolves by its new name (would be null if orphaned).
    const byNew = await gql(request, token, READ, { name: newName });
    expect(byNew.data?.findOneComposant?._id).toBe(id);
});
