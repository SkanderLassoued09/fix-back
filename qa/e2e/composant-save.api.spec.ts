import { test, expect } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { getAuthToken, gql } from './_helpers';

/**
 * Composant « Enregistrer » (addComposantInfo) — API contract.
 *
 * Locks the fix for the magasin « Affectation pour les composants » modal where
 * the save hung forever:
 *  - the mutation now matches by `_id` and persists EVERY field, incl. `name`
 *    (the old path matched by name and never $set name → editing Nom crashed
 *    with "Cannot return null for non-nullable field" → permanent spinner);
 *  - a missing row returns a clean NOT_FOUND, never INTERNAL_SERVER_ERROR.
 *
 * Uses variables (no string interpolation) — the front sends the same fields.
 */

const TAG = Date.now().toString(36);

const CREATE = `mutation($i: CreateComposantInput!){
  createComposant(createComposantInput:$i){ _id name }
}`;
const SAVE = `mutation($i: CreateComposantInput!){
  addComposantInfo(updateComposant:$i){
    _id name package category_composant_id prix_achat prix_vente
    coming_date link quantity_stocked pdf status_composant
  }
}`;
const READ = `query($name:String!){
  findOneComposant(name:$name){
    _id name package category_composant_id prix_achat prix_vente
    coming_date link quantity_stocked pdf status_composant
  }
}`;

function baseInput(id: string, name: string) {
    return {
        _id: id,
        name,
        package: 'PKG-0',
        category_composant_id: 'CAT-0',
        prix_achat: 1,
        prix_vente: 2,
        coming_date: '2026-06-10',
        link: 'http://parts.tn/0',
        quantity_stocked: 5,
        pdf: 'null',
        status_composant: 'En stock',
    };
}

let token: string;
let cmpId: string;
let cmpName = `QA Cmp ${TAG}`;

test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request);
    const r = await gql(request, token, CREATE, {
        i: { name: cmpName, package: 'init', prix_achat: 1, prix_vente: 2 },
    });
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(0);
    cmpId = r.data?.createComposant?._id;
    expect(cmpId).toBeTruthy();
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db
            .collection('composants')
            .deleteMany({ name: { $regex: `${TAG}` } });
    });
});

// Each editable field → save → re-read → assert persisted. `name` last so the
// later cases address the (possibly renamed) row by id anyway.
const FIELD_CASES: Array<{ field: string; value: any }> = [
    { field: 'package', value: `PKG-${TAG}` },
    { field: 'category_composant_id', value: `CAT-${TAG}` },
    { field: 'prix_achat', value: 12.5 },
    { field: 'prix_vente', value: 30 },
    { field: 'coming_date', value: '2026-12-31' },
    { field: 'link', value: `http://parts.tn/${TAG}` },
    { field: 'quantity_stocked', value: 42 },
    { field: 'status_composant', value: 'Externe' },
];

for (const { field, value } of FIELD_CASES) {
    test(`Enregistrer persists « ${field} »`, async ({ request }) => {
        const input: any = baseInput(cmpId, cmpName);
        input[field] = value;
        const save = await gql(request, token, SAVE, { i: input });
        expect(save.errors, JSON.stringify(save.errors)).toHaveLength(0);
        expect(save.data?.addComposantInfo?.[field]).toBe(value);

        // Proof via an independent re-read (refetch / reopen the modal).
        const read = await gql(request, token, READ, { name: cmpName });
        expect(read.data?.findOneComposant?.[field]).toBe(value);
    });
}

test('Enregistrer persists « name » (Nom) — the case that used to hang', async ({
    request,
}) => {
    const newName = `QA Cmp ${TAG} renamed`;
    const input: any = baseInput(cmpId, newName);
    const save = await gql(request, token, SAVE, { i: input });
    expect(save.errors, JSON.stringify(save.errors)).toHaveLength(0);
    expect(save.data?.addComposantInfo?.name).toBe(newName);
    // Old name no longer resolves; new name does (proves the rename persisted).
    const byNew = await gql(request, token, READ, { name: newName });
    expect(byNew.data?.findOneComposant?._id).toBe(cmpId);
    cmpName = newName; // keep subsequent cleanup/readers in sync
});

test('PDF field persists (stored file name returned, not the base64)', async ({
    request,
}) => {
    const input: any = baseInput(cmpId, cmpName);
    // A tiny valid base64 data URL → backend writes a file and stores its name.
    input.pdf =
        'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PD4+CmVuZG9iago=';
    const save = await gql(request, token, SAVE, { i: input });
    expect(save.errors, JSON.stringify(save.errors)).toHaveLength(0);
    const pdf = save.data?.addComposantInfo?.pdf;
    expect(pdf).toBeTruthy();
    expect(pdf).not.toContain('base64'); // a generated file name, not the blob
    expect(pdf).toMatch(/\.(pdf|[a-z0-9]+)$/i);
});

test('Unknown composant → clean NOT_FOUND, never INTERNAL_SERVER_ERROR', async ({
    request,
}) => {
    const input: any = baseInput('Cmp-does-not-exist-xyz', `ghost ${TAG}`);
    const r = await gql(request, token, SAVE, { i: input });
    expect(r.status).toBe(200);
    expect(r.data?.addComposantInfo).toBeFalsy();
    expect(r.code).toBe('NOT_FOUND');
    expect(r.code).not.toBe('INTERNAL_SERVER_ERROR');
});

test('Repeated saves stay healthy (no progressive blocking)', async ({
    request,
}) => {
    for (let i = 0; i < 4; i++) {
        const input: any = baseInput(cmpId, cmpName);
        input.quantity_stocked = 100 + i;
        const save = await gql(request, token, SAVE, { i: input });
        expect(save.errors, `iteration ${i}`).toHaveLength(0);
        expect(save.data?.addComposantInfo?.quantity_stocked).toBe(100 + i);
    }
});
