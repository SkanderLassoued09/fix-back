import { test, expect, Page, Locator } from '@playwright/test';
import { authFile } from '../utils/auth';

/**
 * Dossier d'intervention — refonte en ONGLETS + données de retour.
 *
 * Couvre ce que la refonte a ajouté et ce que l'audit a corrigé :
 *   • les 5 onglets s'ouvrent et chargent (chargement paresseux) ;
 *   • un cycle de RETOUR affiche un dossier complet grâce à l'héritage
 *     marqué (« ce cycle » / « hérité ») — la ligne `logsdis` ne porte en
 *     pratique qu'une poignée de champs ;
 *   • le contexte du retour (niveau, date, motif) est affiché ;
 *   • plus de « — » là où la donnée existe (date de création, société,
 *     catégorie, techniciens), et aucun ObjectId brut à l'écran.
 *
 * LECTURE SEULE : aucun test ne mute une DI.
 */

const TICKET_LIST = '/tickets/ticket/ticket-list';

/** Fixtures RÉELLES (vérifiées en base `fixtronixproddb`). */
const DI = {
  /** T288 — 1 retour, 37 transitions dont RETOUR1, motif renseigné, et une
   *  ligne de log CREUSE : le cas de référence de l'héritage marqué. */
  retourRiche: 'DI_tumA',
  /** DI19 — 2 retours. */
  deuxRetours: 'DI_RCm5',
  /** DI23 — aucun retour → pas de sélecteur de cycle. */
  sansRetour: 'DI_fluK',
  /** T1420 — 13 transitions réelles, 0 retour. */
  parcoursRiche: 'DI_Yzki',
};

async function openModal(page: Page, diId: string): Promise<Locator> {
  await page.goto(`${TICKET_LIST}?di=${diId}&action=detail`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page, 'redirigé vers /auth/login → token expiré ?').not.toHaveURL(
    /\/auth\/login/,
  );
  const modal = page.locator('.di-info-modal');
  await expect(modal).toBeVisible({ timeout: 25_000 });
  await expect(modal.locator('.di-facts .di-fact').first()).toBeVisible({
    timeout: 20_000,
  });
  return modal;
}

const tabButton = (modal: Locator, label: string) =>
  modal.locator('.di-tab', { hasText: label });

async function openTab(modal: Locator, label: string) {
  const tab = tabButton(modal, label);
  await tab.click();
  await expect(tab).toHaveClass(/di-tab--active/);
  // Fin du chargement paresseux de l'onglet.
  await expect(modal.locator('.di-loading')).toHaveCount(0, { timeout: 20_000 });
}

/** Passe sur la pastille de cycle d'indice `i` (0 = flux original). */
async function selectCycle(modal: Locator, i: number) {
  const pill = modal.locator('.di-cycle-pill').nth(i);
  await pill.click();
  await expect(pill).toHaveClass(/di-cycle-pill--active/);
}

test.use({ storageState: authFile('ADMIN_MANAGER') });

test.describe('Dossier DI — onglets', () => {
  test('les 5 onglets existent, « Dossier » est actif par défaut', async ({
    page,
  }) => {
    const modal = await openModal(page, DI.parcoursRiche);
    await expect(modal.locator('.di-tab')).toHaveCount(5);
    await expect(tabButton(modal, 'Dossier')).toHaveClass(/di-tab--active/);
    for (const label of ['Journal', 'Temps & chrono', 'Finances', 'Liens']) {
      await expect(tabButton(modal, label)).toBeVisible();
    }
  });

  test('chaque onglet s’ouvre et rend du contenu (pas de spinner bloqué)', async ({
    page,
  }) => {
    const modal = await openModal(page, DI.parcoursRiche);
    for (const label of ['Journal', 'Temps & chrono', 'Finances', 'Liens']) {
      await openTab(modal, label);
      const body = modal.locator('.di-body');
      await expect(body).toBeVisible();
      // Un onglet vide DOIT le dire ; il ne doit jamais rester muet.
      const hasSection = await body.locator('.di-sec').count();
      expect(hasSection, `onglet ${label} sans contenu`).toBeGreaterThan(0);
    }
  });

  test('journal : lignes datées, jamais « par — » ni ObjectId brut', async ({
    page,
  }) => {
    const modal = await openModal(page, DI.parcoursRiche);
    await openTab(modal, 'Journal');
    const rows = modal.locator('.di-jrow');
    // T1420 a 13 transitions réelles → le journal ne peut pas être vide.
    expect(await rows.count()).toBeGreaterThan(0);
    const txt = await modal.locator('.di-journal').innerText();
    // `actorName` est résolu côté serveur : plus jamais « par — ».
    expect(txt).not.toContain('par —');
    // Aucun ObjectId 24-hex ne doit atteindre l'écran.
    expect(txt).not.toMatch(/\b[0-9a-f]{24}\b/i);
  });
});

test.describe('Dossier DI — cycles de retour', () => {
  test('aucun retour → pas de sélecteur de cycle', async ({ page }) => {
    const modal = await openModal(page, DI.sansRetour);
    await expect(modal.locator('.di-cycles')).toHaveCount(0);
  });

  test('2 retours → 3 pastilles, la plus récente active', async ({ page }) => {
    const modal = await openModal(page, DI.deuxRetours);
    const pills = modal.locator('.di-cycle-pill');
    await expect(pills).toHaveCount(3); // Flux original + Retour 1 + Retour 2
    await expect(pills.nth(2)).toHaveClass(/di-cycle-pill--active/);
  });

  test('T288 — le cycle de retour affiche un dossier COMPLET (héritage marqué)', async ({
    page,
  }) => {
    const modal = await openModal(page, DI.retourRiche);
    await expect(modal.locator('.di-cycles')).toBeVisible();
    await selectCycle(modal, 1); // Retour 1

    // Le contexte du retour est affiché (niveau + date et/ou motif).
    const banner = modal.locator('.di-retour-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Retour 1');

    // La ligne `logsdis` de T288 ne porte QUE contain_pdr / array_composants /
    // flags : sans héritage, tout le reste serait vide. On vérifie que les
    // sections héritées sont bien rendues, et marquées comme telles.
    const markers = modal.locator('.di-origin');
    expect(
      await markers.count(),
      'aucun marqueur d’origine sur un cycle de retour',
    ).toBeGreaterThan(0);
    const labels = (await markers.allInnerTexts()).map((t) => t.trim());
    expect(labels.some((l) => l === 'hérité' || l === 'ce cycle')).toBeTruthy();

    // Les composants du cycle viennent bien du log (donc « ce cycle »).
    await expect(modal.locator('.di-comp__row').first()).toBeVisible();

    // Et le dossier n'est pas vide : l'état est rendu.
    await expect(modal.locator('.di-state__chip').first()).toBeVisible();
  });

  test('T288 — revenir au flux original ne laisse aucun marqueur d’origine', async ({
    page,
  }) => {
    const modal = await openModal(page, DI.retourRiche);
    await selectCycle(modal, 0); // Flux original
    // Sur le flux original il n'y a rien à distinguer : aucun marqueur.
    await expect(modal.locator('.di-origin')).toHaveCount(0);
  });
});

test.describe('Dossier DI — données correctement rendues', () => {
  test('en-tête : date de création réelle (plus de « — »)', async ({ page }) => {
    const modal = await openModal(page, DI.parcoursRiche);
    const sub = await modal.locator('.di-head__sub').innerText();
    // Le back renvoyait un format non parsable → « créé par X · — ».
    expect(sub).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  test('faits : client/société, emplacement et catégorie renseignés', async ({
    page,
  }) => {
    const modal = await openModal(page, DI.parcoursRiche);
    const facts = modal.locator('.di-facts .di-fact');
    const n = await facts.count();
    expect(n).toBeGreaterThanOrEqual(5);
    const txt = await modal.locator('.di-facts').innerText();
    // Les sentinelles back ne doivent plus fuiter jusqu'à l'écran.
    expect(txt).not.toContain('N/A');
    expect(txt).not.toMatch(/\b[0-9a-f]{24}\b/i);
  });

  test('aucun « undefined » ni ObjectId sur l’ensemble du dossier', async ({
    page,
  }) => {
    const modal = await openModal(page, DI.retourRiche);
    for (const label of ['Journal', 'Temps & chrono', 'Finances', 'Liens']) {
      await openTab(modal, label);
      const txt = await modal.innerText();
      expect(txt.toLowerCase(), `onglet ${label}`).not.toContain('undefined');
      expect(txt, `onglet ${label}`).not.toMatch(/\b[0-9a-f]{24}\b/i);
    }
  });

  test('timeline : les entrées reconstruites sont signalées', async ({
    page,
  }) => {
    // DI19 n'avait aucun historique : la migration 011 l'a reconstruit.
    const modal = await openModal(page, DI.deuxRetours);
    await selectCycle(modal, 0);
    const steps = modal.locator('.di-step');
    if ((await steps.count()) > 0) {
      // Une entrée déduite ne doit jamais se faire passer pour une observation.
      await expect(modal.locator('.di-origin', { hasText: 'reconstruit' }).first()).toBeVisible();
    } else {
      await expect(modal.locator('.di-empty').first()).toBeVisible();
    }
  });
});

test.describe('Dossier DI — édition réservée à ADMIN_TECH', () => {
  test('ADMIN_TECH voit le bouton « Modifier »', async ({ browser }) => {
    const ctx = await browser.newContext({
      storageState: authFile('ADMIN_TECH'),
    });
    const page = await ctx.newPage();
    const modal = await openModal(page, DI.parcoursRiche);
    await expect(
      modal.locator('.di-head__actions').getByRole('button', { name: /Modifier/ }),
    ).toBeVisible();
    await ctx.close();
  });

  test('MANAGER ne voit PAS le bouton « Modifier »', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: authFile('MANAGER') });
    const page = await ctx.newPage();
    const modal = await openModal(page, DI.parcoursRiche);
    await expect(
      modal.locator('.di-head__actions').getByRole('button', { name: /Modifier/ }),
    ).toHaveCount(0);
    await ctx.close();
  });
});
