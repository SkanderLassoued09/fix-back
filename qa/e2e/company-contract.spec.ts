import { test, expect } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';
import { getAuthToken, gql, createCompany, minimalCompany } from './_helpers';

/**
 * Company — FRONT↔BACK field contract (FIELD_CONTRACT audit).
 *
 * Locks the two contract fixes:
 *  - duplicate guard: re-creating an ACTIVE raison sociale / MF → business
 *    `CONFLICT` naming the field (inline in the UI), never a generic error;
 *    soft-deleted companies never block a re-creation.
 *  - URL strictness aligned: `http://localhost:4200/…` (the reported payload)
 *    is caught CLIENT-side; on the API it stays a clean BAD_REQUEST listing
 *    `webSiteLink` (never a 500).
 */

const TAG = Date.now().toString(36);
const dupId = `QA_CONTRACT_${TAG}`;
const dupName = `QA Contract Co ${TAG}`;

test.beforeAll(async () => {
    await withDb(async (db) => {
        await db.collection('companies').insertOne({
            _id: dupId,
            name: dupName,
            raisonSociale: dupName,
            mf: `MF${TAG}`,
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db
            .collection('companies')
            .deleteMany({ raisonSociale: { $regex: `${TAG}$` } });
    });
});

// ── API ──────────────────────────────────────────────────────────────────

test('API: duplicate raison sociale → CONFLICT(raisonSociale), message « existe déjà »', async ({
    request,
}) => {
    const token = await getAuthToken(request);
    const r = await createCompany(request, token, {
        name: dupName,
        raisonSociale: dupName,
    });
    expect(r.data?.createCompany).toBeFalsy();
    expect(r.code).toBe('CONFLICT');
    expect(r.errors[0]?.extensions?.field).toBe('raisonSociale');
    expect(r.errors[0]?.message).toMatch(/existe déjà/i);
});

test('API: duplicate MF → CONFLICT(mf)', async ({ request }) => {
    const token = await getAuthToken(request);
    const r = await createCompany(request, token, {
        name: `${dupName} bis`,
        raisonSociale: `${dupName} bis`,
        mf: `MF${TAG}`,
    });
    expect(r.code).toBe('CONFLICT');
    expect(r.errors[0]?.extensions?.field).toBe('mf');
});

test('API: soft-deleted company never blocks a re-creation', async ({
    request,
}) => {
    const token = await getAuthToken(request);
    const name = `QA Recreate ${TAG}`;
    const c1 = await createCompany(request, token, {
        ...minimalCompany(`re-${TAG}`),
        name,
        raisonSociale: name,
        mf: undefined,
    });
    expect(c1.data?.createCompany?._id).toBeTruthy();
    const del = await gql(
        request,
        token,
        `mutation($id: String!){ removeCompany(_id: $id){ isDeleted } }`,
        { id: c1.data.createCompany._id },
    );
    expect(del.data?.removeCompany?.isDeleted).toBe(true);
    const c2 = await createCompany(request, token, {
        ...minimalCompany(`re-${TAG}`),
        name,
        raisonSociale: name,
        mf: undefined,
    });
    expect(c2.errors).toHaveLength(0);
    expect(c2.data?.createCompany?._id).toBeTruthy();
});

test('API: reported payload (localhost URL) → clean BAD_REQUEST listing webSiteLink', async ({
    request,
}) => {
    const token = await getAuthToken(request);
    const r = await createCompany(request, token, {
        name: `QA Url ${TAG}`,
        raisonSociale: `QA Url ${TAG}`,
        webSiteLink: 'http://localhost:4200/#/pages/company',
    });
    expect(r.status).toBe(200);
    expect(r.code).toBe('BAD_REQUEST');
    expect(
        (r.errors[0]?.extensions?.validation ?? []).join(' '),
    ).toMatch(/webSiteLink/);
});

test('API: overlong region (>120) → handled BAD_REQUEST, never a crash', async ({
    request,
}) => {
    const token = await getAuthToken(request);
    const r = await createCompany(request, token, {
        name: `QA Region ${TAG}`,
        raisonSociale: `QA Region ${TAG}`,
        region: 'X'.repeat(130),
    });
    expect(r.status).toBe(200);
    expect(r.code).toBe('BAD_REQUEST');
});

// ── UI ───────────────────────────────────────────────────────────────────

test.describe('UI', () => {
    test.use({ storageState: authFile('ADMIN_MANAGER') });
    const ROUTE = '/companies/company/company-list';

    test('duplicate via the form → inline « existe déjà » on Raison sociale, no generic toast, button never frozen', async ({
        page,
    }) => {
        await page.goto(ROUTE);
        await page
            .getByRole('button', { name: /Ajouter une soci/i })
            .first()
            .click();
        await expect(page.locator('.co-modal')).toBeVisible({ timeout: 10000 });

        await page.locator('#companyName').fill(dupName);
        const primary = page.locator('.co-btn--primary');
        await expect(primary).toBeEnabled();
        await primary.click();
        await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();

        // CONFLICT mapped INLINE on the raison sociale field…
        const err = page.locator('.co-modal .co-err', {
            hasText: /existe déjà/i,
        });
        await expect(err).toBeVisible({ timeout: 12000 });
        // …no toast at all (specific inline feedback replaces the old generic
        // « Erreur lors de l'ajout de la société »).
        await expect(page.locator('.p-toast-message')).toHaveCount(0);
        // Button never frozen.
        await expect(primary).toBeEnabled();

        // Recovery: editing the field clears the conflict.
        await page.locator('#companyName').fill(`${dupName} v2`);
        await expect(err).toHaveCount(0, { timeout: 6000 });
        await page.keyboard.press('Escape');
    });

    test('localhost website URL is caught CLIENT-side (inline + submit disabled)', async ({
        page,
    }) => {
        await page.goto(ROUTE);
        await page
            .getByRole('button', { name: /Ajouter une soci/i })
            .first()
            .click();
        await expect(page.locator('.co-modal')).toBeVisible({ timeout: 10000 });

        await page.locator('#companyName').fill(`QA Url UI ${TAG}`);
        const website = page.locator('#website');
        await website.fill('http://localhost:4200/#/pages/company');
        await website.blur();

        // Inline format error, before any server round-trip…
        await expect(
            page.locator('.co-modal .co-err', { hasText: /Format invalide/i }),
        ).toBeVisible();
        // …and the submit is gated on client validity.
        await expect(page.locator('.co-btn--primary')).toBeDisabled();

        // A real URL re-enables it.
        await website.fill('https://fixtronix.tn');
        await expect(page.locator('.co-btn--primary')).toBeEnabled();
        await page.keyboard.press('Escape');
    });
});
