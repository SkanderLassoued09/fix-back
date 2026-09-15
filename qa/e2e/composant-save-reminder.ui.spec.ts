import { test, expect } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Magasin « Affectation pour les composants » — rappel « pensez à Enregistrer ».
 *
 * Verrouille le retour visuel ajouté au pied du modal : tant que le composant
 * actif porte des modifications non enregistrées, le pied affiche un rappel et
 * le bouton « Enregistrer » porte `.cmp-btn--attention` (aplat ambre + reflet
 * sur sa face) — la COULEUR est vérifiée aussi, pas seulement la classe : une
 * règle de spécificité perdue garderait la classe mais laisserait le bouton
 * bleu. Même condition : « Valider ce composant » reste grisé tant que
 * « Enregistrer » n'a pas été fait.
 *
 *  - ouverture (chargement du formulaire) → AUCUN rappel, Enregistrer grisé ;
 *  - champ modifié + formulaire valide     → rappel ambre + reflet, Valider grisé ;
 *  - champ requis vidé                      → rappel « complétez », SANS reflet ;
 *  - après « Enregistrer »                  → rappel éteint, Enregistrer grisé,
 *                                             Valider réactivé ;
 *  - changement de composant dans le rail   → rappel éteint.
 *
 * Même gabarit de seed que `composant-save.ui.spec.ts` : une DI
 * MagasinEstimation autonome + ses composants, hard-delete à la fin.
 */

test.use({ storageState: authFile('MAGASIN') });

const ROUTE = '/tickets/ticket/magasin-di-list';
const TAG = Date.now().toString(36);
const cmpAId = `Cmp_rmdA_${TAG}`;
const cmpAName = `QA Rappel A ${TAG}`;
const cmpBId = `Cmp_rmdB_${TAG}`;
const cmpBName = `QA Rappel B ${TAG}`;
const diId = `DI_rmd_${TAG}`;
const diNum = `RMD-${TAG}`;
/** Aplat de « Enregistrer » : repos = `--fx-blue`, à enregistrer = `--fx-amber-strong`. */
const BLUE = 'rgb(59, 130, 246)';
const AMBER = 'rgb(180, 83, 9)';

const composant = (_id: string, name: string) => ({
    _id,
    name,
    package: 'old-pkg',
    // _id RÉEL d'une catégorie vivante : `normalizeCategoryId` renvoie null
    // pour une catégorie inconnue (re-choix forcé), le formulaire serait alors
    // invalide DÈS le chargement et le rappel partirait du mauvais pied.
    category_composant_id: 'C_Composant3',
    prix_achat: 1,
    prix_vente: 2,
    coming_date: '2026-06-10',
    link: 'http://parts.tn/old',
    quantity_stocked: 5,
    pdf: null,
    status_composant: 'En stock',
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
});

test.beforeAll(async () => {
    await withDb(async (db) => {
        await db
            .collection('composants')
            .insertMany([
                composant(cmpAId, cmpAName),
                composant(cmpBId, cmpBName),
            ]);
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: diNum,
            title: `QA Rappel DI ${TAG}`,
            description: 'rappel enregistrer',
            contain_pdr: true,
            status: 'MagasinEstimation',
            current_roles: ['Magasin'],
            isDeleted: false,
            ignoreCount: 0,
            array_composants: [
                { nameComposant: cmpAName, quantity: 2, isUpdated: false },
                { nameComposant: cmpBName, quantity: 1, isUpdated: false },
            ],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db
            .collection('composants')
            .deleteMany({ _id: { $in: [cmpAId, cmpBId] } });
        await db.collection('dis').deleteOne({ _id: diId });
    });
});

test('le rappel « Enregistrer » suit l’état modifié du composant actif', async ({
    page,
}) => {
    await page.goto(ROUTE);

    const row = page.locator('tr', { hasText: diNum });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.locator('button:has(.pi-folder-open)').click();

    await expect(page.locator('.cmp-assign')).toBeVisible({ timeout: 10000 });
    const nameInput = page.locator('input[formcontrolname="name"]');
    await expect(nameInput).toHaveValue(cmpAName, { timeout: 10000 });

    const hint = page.locator('.cmp-foot__hint');
    const saveBtn = page.locator('.cmp-btn--save');
    const validateBtn = page.locator('.cmp-detail__foot .cmp-validate');

    // 1) Le CHARGEMENT du formulaire ne compte pas comme une modification.
    await expect(hint).toHaveCount(0);
    await expect(saveBtn).not.toHaveClass(/cmp-btn--attention/);
    // Rien à enregistrer : « Enregistrer » grisé, « Valider » seul actif.
    await expect(saveBtn).toBeDisabled();
    await expect(validateBtn).toBeEnabled();

    // 2) Champ modifié + formulaire valide → rappel ambre + reflet.
    const pkgInput = page.locator('input[formcontrolname="package"]');
    await pkgInput.fill(`pkg-${TAG}`);
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('non enregistrées');
    await expect(hint).toHaveClass(/cmp-foot__hint--ready/);
    await expect(saveBtn).toHaveClass(/cmp-btn--attention/);
    await expect(saveBtn).toBeEnabled();
    // Le bouton LUI-MÊME passe en ambre (--fx-amber-strong #b45309).
    await expect(saveBtn).toHaveCSS('background-color', AMBER);
    // Même condition : « Valider » grisé tant que ce n'est pas enregistré.
    await expect(validateBtn).toBeDisabled();

    // 3) Champ requis vidé → rappel « complétez », bouton grisé et SANS reflet
    //    (on ne fait pas briller un bouton non cliquable).
    await pkgInput.fill('');
    await expect(hint).toContainText('Complétez les champs obligatoires');
    await expect(hint).not.toHaveClass(/cmp-foot__hint--ready/);
    await expect(saveBtn).not.toHaveClass(/cmp-btn--attention/);
    await expect(saveBtn).toBeDisabled();
    await expect(saveBtn).toHaveCSS('background-color', BLUE);

    // 4) « Enregistrer » éteint le rappel.
    await pkgInput.fill(`pkg-${TAG}`);
    await expect(saveBtn).toHaveClass(/cmp-btn--attention/);
    await saveBtn.click();
    await page.locator('.p-confirm-dialog .p-confirm-dialog-accept').click();
    await expect(page.locator('.p-toast-message-success')).toHaveCount(1, {
        timeout: 12000,
    });
    await expect(hint).toHaveCount(0);
    await expect(saveBtn).not.toHaveClass(/cmp-btn--attention/);
    await expect(saveBtn).toHaveCSS('background-color', BLUE);
    // Enregistré → « Enregistrer » grisé, « Valider » redevient cliquable.
    await expect(saveBtn).toBeDisabled();
    await expect(validateBtn).toBeEnabled();

    // 5) Changer de composant dans le rail repart d'un formulaire propre :
    //    une saisie NON enregistrée ne doit pas « suivre » la ligne suivante.
    await pkgInput.fill('jamais-enregistre');
    await expect(hint).toBeVisible();
    await page.locator('.cmp-card', { hasText: cmpBName }).click();
    await expect(nameInput).toHaveValue(cmpBName, { timeout: 10000 });
    await expect(hint).toHaveCount(0);
    await expect(saveBtn).not.toHaveClass(/cmp-btn--attention/);
});
