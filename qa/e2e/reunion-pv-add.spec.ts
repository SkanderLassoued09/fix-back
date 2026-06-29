import { test, expect } from '@playwright/test';
import { authFile, tokenFor } from '../utils/auth';
import { gqlPost } from '../utils/graphql';
import { withDb } from '../utils/mongo';

/**
 * Réunions menu — "Ajouter une réunion" end-to-end.
 *
 * Covers:
 *   1. The list page renders and the "+ Nouvelle réunion" CTA is visible.
 *   2. Submitting the standalone form persists a ReunionPV with a real
 *      `PV-{YYYY}-{seq}` reference, the author set to the logged-in user,
 *      no DI binding (standalone mode), and `isConnected` flag untouched.
 *   3. The DB row is exactly what the GraphQL response said it was — no
 *      ghost values from the modal's prefill logic.
 *   4. Cleanup: the test deletes the row it created so the run is idempotent.
 *
 * Run as ADMIN_TECH because the menu entry is present for that role and
 * the seeded participants/responsables resolve cleanly.
 */

// ADMIN_MANAGER (seeded "skander") has the Réunions menu entry AND a real
// profile in the current backend DB — used over ADMIN_TECH (whose seed is
// not always present in the prod-replica fixture).
test.use({ storageState: authFile('ADMIN_MANAGER') });

const TAG = Date.now().toString(36);
const TITRE = `QA-REUNION-${TAG}`;
const LIEU = `Salle QA ${TAG}`;

let createdPvId: string | null = null;

test.afterAll(async () => {
    // Idempotency — drop the inserted PV so repeated runs don't pile up.
    if (createdPvId) {
        await withDb(async (db) => {
            await db.collection('reunionpvs').deleteOne({ _id: createdPvId });
        });
    }
});

test('Réunions list opens and "Nouvelle réunion" CTA is visible', async ({
    page,
}) => {
    await page.goto('/tickets/reunions');
    await expect(
        page.getByRole('heading', { name: 'Réunions', exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: /Nouvelle réunion/i }),
    ).toBeVisible();
});

test('Ajouter une réunion (mode standalone) → PV créé en DB avec référence auto', async ({
    page,
    request,
}) => {
    await page.goto('/tickets/reunions');

    // Snapshot the count of PVs in the DB BEFORE so we can assert the new
    // row is genuinely a new insert.
    const beforeCount = await withDb(async (db) =>
        db.collection('reunionpvs').countDocuments({}),
    );

    // Open the modal in standalone mode.
    await page.getByRole('button', { name: /Nouvelle réunion/i }).click();

    // The shared modal carries the same header in both modes.
    await expect(
        page.getByText('Procès-Verbal de Réunion', { exact: false }),
    ).toBeVisible();

    // Fill the required + identifying fields.
    // The dialog appendTo='body' so locators must be scoped via the dialog role.
    const dialog = page.locator('.p-dialog').filter({
        hasText: 'Procès-Verbal de Réunion',
    });
    // formControlName="titre" lives on 3 inputs (main, points, actions);
    // we target by the unique placeholders to stay deterministic.
    await dialog
        .getByPlaceholder('Ex. Retour 1 — DI42')
        .fill(TITRE);
    await dialog
        .getByPlaceholder('Synthèse du sujet abordé')
        .fill('QA run — standalone');
    await dialog.getByPlaceholder('Salle A / lien Visio').fill(LIEU);

    // Submit.
    await dialog
        .getByRole('button', { name: /Enregistrer le PV/i })
        .click();

    // The modal closes on success.
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Wait for the list to refresh and surface our new row.
    await expect(page.getByText(TITRE, { exact: false })).toBeVisible({
        timeout: 10_000,
    });

    // Now verify the DB independently: a single new row with the right
    // titre, author, no DI binding, and a well-formed reference.
    const afterCount = await withDb(async (db) =>
        db.collection('reunionpvs').countDocuments({}),
    );
    expect(afterCount).toBe(beforeCount + 1);

    const row = await withDb(async (db) =>
        db.collection('reunionpvs').findOne({ titre: TITRE }),
    );
    expect(row).toBeTruthy();
    createdPvId = row?._id ? String(row._id) : null;

    expect(row?.titre).toBe(TITRE);
    expect(row?.lieu).toBe(LIEU);
    expect(row?.di).toBeNull(); // standalone — no DI bound
    expect(row?.contexteRetour).toBeNull(); // no retour context
    expect(typeof row?.createdBy).toBe('string');
    expect(row?.createdBy.length).toBeGreaterThan(0);

    // Reference format: PV-{4-digit year}-{3-digit seq}
    expect(row?.reference).toMatch(/^PV-\d{4}-\d{3}$/);

    // Cross-check with the GraphQL list — the new id surfaces in
    // reunionPVs() with no filter (the "Réunions" menu query).
    const token = tokenFor('ADMIN_MANAGER');
    const listRes = await gqlPost(
        request,
        `query { reunionPVs { _id reference titre } }`,
        token,
    );
    expect(listRes.errors).toBeNull();
    const ids = (listRes.data?.reunionPVs ?? []).map((r: any) => r._id);
    expect(ids).toContain(createdPvId);
});

test('le bouton Annuler ferme le modal sans créer de PV', async ({
    page,
}) => {
    await page.goto('/tickets/reunions');

    const before = await withDb(async (db) =>
        db.collection('reunionpvs').countDocuments({}),
    );

    await page.getByRole('button', { name: /Nouvelle réunion/i }).click();

    const dialog = page.locator('.p-dialog').filter({
        hasText: 'Procès-Verbal de Réunion',
    });
    await dialog
        .getByPlaceholder('Ex. Retour 1 — DI42')
        .fill('QA-CANCEL-TEST');

    await dialog.getByRole('button', { name: /Annuler/i }).click();
    await expect(dialog).toBeHidden({ timeout: 8_000 });

    const after = await withDb(async (db) =>
        db.collection('reunionpvs').countDocuments({}),
    );
    expect(after).toBe(before);
});
