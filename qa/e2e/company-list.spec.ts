import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Company — UI (Playwright). Drives the redesigned « Gestion des sociétés »
 * modal: create / edit / delete + responsive + console hygiene.
 *
 * Auth: reuse the seeded ADMIN storageState (security out of scope). A row is
 * seeded directly in Mongo for the edit/delete flows (deterministic), and the
 * one UI-created row is hard-deleted in afterAll.
 */

const ROUTE = '/companies/company/company-list';
const TAG = Date.now().toString(36);
const seededId = `QA_UI_${TAG}`;
const seededName = `QA UI Co ${TAG}`;
const delId = `QA_UIDEL_${TAG}`;
const delName = `QA UI Del ${TAG}`;
const createdNames: string[] = [seededName, delName];

test.use({ storageState: authFile('ADMIN_MANAGER') });

test.beforeAll(async () => {
    await withDb(async (db) => {
        await db.collection('companies').insertOne({
            _id: seededId,
            name: seededName,
            region: 'TUNIS',
            address: 'Adresse QA',
            email: 'seed@qa.tn',
            raisonSociale: seededName,
            Exoneration: 'Non',
            fax: '+21671000000',
            webSiteLink: 'https://seed.qa.tn',
            mf: `MF1-${TAG}`,
            rne: 'B123456',
            activitePrincipale: 'Distribution',
            activiteSecondaire: 'Maintenance',
            serviceAchat: { name: 'Achat Seed', email: 'a@qa.tn', phone: '+21620000000' },
            serviceTechnique: null,
            serviceFinancier: null,
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        // Dedicated throwaway row for the real-delete test.
        await db.collection('companies').insertOne({
            _id: delId,
            name: delName,
            region: 'TUNIS',
            address: 'Adresse QA del',
            raisonSociale: delName,
            mf: `MF2-${TAG}`,
            rne: 'B654321',
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('companies').deleteOne({ _id: seededId });
        if (createdNames.length) {
            await db
                .collection('companies')
                .deleteMany({ name: { $in: createdNames } });
        }
    });
});

/** Attach console/page-error capture; returns the collected error list. */
function trackErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push('[console] ' + m.text());
    });
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
    return errors;
}

async function openCreateModal(page: Page) {
    await page.goto(ROUTE);
    await page.getByRole('button', { name: /Ajouter une soci/i }).first().click();
    await expect(page.locator('.co-modal')).toBeVisible({ timeout: 10000 });
}

test('create modal: fields present/editable, required gating, selects, contacts chip add/remove, Esc closes', async ({ page }) => {
    const errors = trackErrors(page);
    await openCreateModal(page);

    // Header is the CREATE title.
    await expect(page.locator('.co-head__title')).toHaveText(/Ajouter une nouvelle soci/i);

    // Required gating: primary disabled while Raison sociale empty.
    const primary = page.locator('.co-btn--primary');
    await expect(primary).toBeDisabled();

    // Field editable.
    const raison = page.locator('#companyName');
    await raison.fill('Société Test QA');
    await expect(raison).toHaveValue('Société Test QA');
    await expect(primary).toBeEnabled();

    // Selects present (Région + Exonération).
    await expect(page.locator('p-dropdown#region, #region')).toBeVisible();
    await expect(page.locator('#Exoneration')).toBeVisible();

    // Contacts: open the Achat editor, type a name → chip appears in the card.
    const achatCard = page.locator('.co-service[data-svc="achat"]');
    await achatCard.locator('.co-service__add').click();
    const editorInput = page.locator('.co-editor input').first();
    await expect(editorInput).toBeVisible();
    await editorInput.fill('Jean Achat');
    await expect(achatCard.locator('.co-chip__name')).toHaveText('Jean Achat');

    // Remove the chip → back to "Aucun contact".
    await achatCard.locator('.co-chip__x').click();
    await expect(achatCard.locator('.co-service__empty')).toBeVisible();

    // Esc closes the modal.
    await page.keyboard.press('Escape');
    await expect(page.locator('.co-modal')).toBeHidden({ timeout: 8000 });

    expect(errors, errors.join('\n')).toHaveLength(0);
});

test('edit: opens prefilled with « Modifier la société » + blue save button', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(ROUTE);

    // Find the seeded row, click its Modifier (pencil, aria-label).
    const row = page.locator('tr', { hasText: seededName });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.getByRole('button', { name: new RegExp(`Modifier`, 'i') }).click();

    await expect(page.locator('.co-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.co-head__title')).toHaveText(/Modifier la soci/i);
    // Prefilled.
    await expect(page.locator('#companyName')).toHaveValue(seededName);
    // Blue "save" button (edit), not the green create one.
    await expect(page.locator('.co-btn--save')).toBeVisible();
    await expect(page.locator('.co-btn--save')).toHaveText(/Enregistrer les modifications/i);
    await expect(page.locator('.co-btn--primary')).toHaveCount(0);
    // Existing Achat contact surfaces as a chip.
    await expect(page.locator('.co-service[data-svc="achat"] .co-chip__name')).toHaveText('Achat Seed');

    await page.locator('.co-head__close').click();
    await expect(page.locator('.co-modal')).toBeHidden();
    expect(errors, errors.join('\n')).toHaveLength(0);
});

test('delete: red dialog shows the company name; Annuler closes without deleting', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(ROUTE);

    const row = page.locator('tr', { hasText: seededName });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.getByRole('button', { name: /Supprimer/i }).click();

    const dialog = page.locator('.co-delete');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(dialog.locator('.co-delete__title')).toHaveText(/Supprimer la soci/i);
    // The company name is shown (bold) in the body.
    await expect(dialog.locator('.co-delete__body strong')).toHaveText(seededName);
    // Supprimer is the red destructive button.
    await expect(dialog.locator('.co-btn--danger')).toBeVisible();

    // Annuler closes WITHOUT deleting.
    await dialog.locator('.co-btn--ghost').click();
    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect(page.locator('tr', { hasText: seededName })).toBeVisible();

    expect(errors, errors.join('\n')).toHaveLength(0);
});

test('create: fill required → confirm → company appears in the list (front variables path)', async ({ page }) => {
    const errors = trackErrors(page);
    const name = `QA UI Create ${TAG}`;
    createdNames.push(name);

    await openCreateModal(page);
    await page.locator('#companyName').fill(name);
    await page.locator('.co-btn--primary').click();

    // PrimeNG confirmation → accept.
    const accept = page.locator('.p-confirm-dialog .p-confirm-dialog-accept');
    await expect(accept).toBeVisible({ timeout: 8000 });
    await accept.click();

    // On success the modal closes and the new row appears in the reloaded list.
    await expect(page.locator('.co-modal')).toBeHidden({ timeout: 12000 });
    await expect(page.locator('tr', { hasText: name })).toBeVisible({ timeout: 15000 });

    expect(errors, errors.join('\n')).toHaveLength(0);
});

test('validation: invalid email blocks submit + shows error; fixing re-enables', async ({ page }) => {
    const errors = trackErrors(page);
    await openCreateModal(page);
    const primary = page.locator('.co-btn--primary');

    // Required filled → submit enabled.
    await page.locator('#companyName').fill('Validation QA');
    await expect(primary).toBeEnabled();

    // Invalid email → error under field + submit disabled.
    await page.locator('#email').fill('not-an-email');
    await page.locator('#email').blur();
    await expect(page.locator('.co-err').first()).toBeVisible();
    await expect(primary).toBeDisabled();

    // Fix email → enabled again.
    await page.locator('#email').fill('ok@qa.tn');
    await page.locator('#email').blur();
    await expect(primary).toBeEnabled();

    // Clearing the required Raison sociale → disabled again.
    await page.locator('#companyName').fill('');
    await page.locator('#companyName').blur();
    await expect(primary).toBeDisabled();

    await page.keyboard.press('Escape');
    expect(errors, errors.join('\n')).toHaveLength(0);
});

test('delete: confirm → exactly one toast → row removed (no duplicate)', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(ROUTE);

    const row = page.locator('tr', { hasText: delName });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.getByRole('button', { name: /Supprimer/i }).click();

    const dialog = page.locator('.co-delete');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await dialog.locator('.co-btn--danger').click();

    // Assert the toast count FIRST (before it auto-dismisses): exactly ONE.
    // The old bug rendered TWO simultaneously (count would settle at 2 → fail);
    // a single toast settles at 1.
    await expect(page.locator('.p-toast-message')).toHaveCount(1, { timeout: 8000 });
    // Then the dialog closes and the row is gone.
    await expect(dialog).toBeHidden({ timeout: 12000 });
    await expect(page.locator('tr', { hasText: delName })).toHaveCount(0, { timeout: 15000 });

    expect(errors, errors.join('\n')).toHaveLength(0);
});

test('server validation maps to the field: financier email rejected → inline error, button stays clickable, no toast, fix clears it', async ({ page }) => {
    const errors = trackErrors(page);
    const name = `QA Srv ${TAG}`;
    createdNames.push(name); // in case the server unexpectedly accepts it

    await openCreateModal(page);
    await page.locator('#companyName').fill(name);

    // Open the financier contact editor and enter an email that PASSES Angular's
    // Validators.email but FAILS class-validator @IsEmail (no TLD) → the form is
    // client-valid (button enabled) but the server returns BAD_REQUEST.
    await page.locator('.co-service[data-svc="financier"] .co-service__add').click();
    const finEditor = page.locator('.co-editor', { hasText: 'Responsable financier' });
    await expect(finEditor).toBeVisible();
    const finEmail = finEditor.locator('input[type="email"]');
    await finEmail.fill('test@test');

    const primary = page.locator('.co-btn--primary');
    await expect(primary, 'client-valid → submit enabled').toBeEnabled();

    // Submit + confirm.
    await primary.click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();

    // Server rejection mapped INLINE under the financier email field.
    await expect(finEditor.locator('.co-err')).toBeVisible({ timeout: 12000 });
    await expect(finEditor.locator('.co-err')).toHaveText(/e-mail invalide|email/i);
    // Button is NEVER frozen by a server error.
    await expect(primary, 'button stays clickable after server error').toBeEnabled();
    // NO per-field toast (inline only).
    await expect(page.locator('.p-toast-message')).toHaveCount(0);

    // Recovery: editing the field clears the server error.
    await finEmail.fill('ok@valid.tn');
    await expect(finEditor.locator('.co-err')).toHaveCount(0, { timeout: 6000 });

    await page.keyboard.press('Escape');
    expect(errors, errors.join('\n')).toHaveLength(0);
});

test('responsive @390px: modal has no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openCreateModal(page);
    // The dialog content must not overflow horizontally.
    const overflow = await page.evaluate(() => {
        const el = document.querySelector('.co-modal') as HTMLElement | null;
        if (!el) return { ok: false, sw: 0, cw: 0 };
        return { ok: el.scrollWidth <= el.clientWidth + 1, sw: el.scrollWidth, cw: el.clientWidth };
    });
    expect(overflow.ok, `co-modal overflows: scrollWidth=${overflow.sw} clientWidth=${overflow.cw}`).toBe(true);
    // Document-level horizontal scroll also absent.
    const docOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    expect(docOverflow, 'document has horizontal scroll at 390px').toBe(true);
});
