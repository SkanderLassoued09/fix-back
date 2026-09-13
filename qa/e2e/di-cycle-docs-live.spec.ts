import { test, expect, APIRequestContext } from '@playwright/test';
import { withDb } from '../utils/mongo';
import { gqlPost } from '../utils/graphql';
import { authFile, tokenFor } from '../utils/auth';

/**
 * PREUVE DE BOUT EN BOUT — les documents appartiennent à leur CYCLE.
 *
 * `di.cycle-isolation.spec.ts` verrouille déjà les invariants côté service, mais
 * sur des mocks. Ici on le prouve sur une VRAIE DI, par les VRAIES mutations
 * (upload Drive compris) : c'est la garantie que « la prochaine fois », la modale
 * « Affectation des Fichiers » aura bien de quoi séparer origine et retours.
 *
 * Contexte : les documents du cycle 0 de 30 DI héritées sont perdus, car
 * `RETOUR_CYCLE_RESET` vidait le miroir avant que le stockage par cycle
 * n'existe. Ce test verrouille le fait que ça ne peut plus se reproduire.
 *
 * Ce qui est réellement exercé : `createDi`, `addDevis`, `addBC`, `addBl`,
 * `addFacture`, `changeStatusRetour`. Le seul raccourci est le POSITIONNEMENT du
 * statut avant le retour (écriture Mongo directe), convention du harnais :
 * Mongo pour les préconditions, mutations réelles pour ce qui est testé.
 */

const tag = `cyc_live_${Date.now().toString(36)}`;
let DI_ID = '';
let TOKEN = '';

/** Le plus petit PDF valide qui soit — Drive l'accepte, et il pèse ~300 octets. */
const PDF_B64 =
    'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZX' +
    'MgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50ID' +
    'E+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMC' +
    'A5OSA5OV0+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4K';

const DOC_FIELDS = ['devis', 'bon_de_commande', 'bon_de_livraison', 'facture'] as const;

test.use({ storageState: authFile('ADMIN_MANAGER') });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    TOKEN = (await tokenFor('ADMIN_MANAGER')) as string;
    expect(TOKEN, 'jeton ADMIN_MANAGER — lancer `npm run verify:auth`').toBeTruthy();
});

test.afterAll(async () => {
    if (!DI_ID) return;
    await withDb(async (db) => {
        await db.collection('dis').deleteOne({ _id: DI_ID });
        await db.collection('stats').deleteMany({ _idDi: DI_ID });
        await db.collection('logsdis').deleteMany({ _idDi: DI_ID });
        await db.collection('notifications').deleteMany({ diId: DI_ID });
        await db.collection('system_events').deleteMany({ diId: DI_ID });
    });
});

/** Ligne de cycle `n` d'une DI. */
const cycleRow = (diId: string, n: number) =>
    withDb((db) => db.collection('logsdis').findOne({ _idDi: diId, idIgnore: n }));

async function mutate(request: APIRequestContext, query: string) {
    const r = await gqlPost(request, query, TOKEN);
    expect(r.errors?.[0]?.message ?? null, `mutation en échec : ${query.slice(0, 70)}`).toBeNull();
    return r;
}

test('1 — une DI créée ouvre AUSSITÔT son dossier de cycle 0', async ({ request }) => {
    const refs = await withDb(async (db) => ({
        client: await db.collection('clients').findOne({ isDeleted: { $ne: true } }),
        location: await db.collection('locations').findOne({ isDeleted: { $ne: true } }),
    }));

    const r = await mutate(request, `mutation { createDi(createDiInput: {
        title: "QA cycle docs ${tag}"
        description: "preuve de bout en bout du stockage par cycle"
        client_id: "${refs.client?._id}"
        location_id: "${refs.location?._id}"
        nSerie: "${tag}"
    }) { _id _idnum status ignoreCount } }`);

    DI_ID = r.data.createDi._id;
    expect(DI_ID).toBeTruthy();
    expect(r.data.createDi.ignoreCount ?? 0).toBe(0);

    // C'est CE point qui manquait aux 30 DI héritées.
    expect(await cycleRow(DI_ID, 0), 'ligne de cycle 0 absente à la création').not.toBeNull();
});

test('2 — les 4 documents déposés au cycle 0 atterrissent sur la ligne du cycle 0', async ({ request }) => {
    for (const [m, field] of [
        ['addDevis', 'devis'],
        ['addBC', 'bon_de_commande'],
        ['addBl', 'bon_de_livraison'],
        ['addFacture', 'facture'],
    ] as const) {
        await mutate(request, `mutation { ${m}(_id: "${DI_ID}", pdf: "${PDF_B64}") { _id } }`);
        void field;
    }

    const c0: any = await cycleRow(DI_ID, 0);
    for (const f of DOC_FIELDS) {
        expect(c0?.[f], `${f} absent de la ligne de cycle 0`).toBeTruthy();
    }

    // Le miroir porte les mêmes documents (il reflète le cycle courant = 0).
    const di: any = await withDb((db) => db.collection('dis').findOne({ _id: DI_ID }));
    for (const f of DOC_FIELDS) expect(di?.[f], `${f} absent du miroir`).toBeTruthy();
});

test('3 — le retour vide le MIROIR mais laisse le cycle 0 INTACT', async ({ request }) => {
    const before: any = await cycleRow(DI_ID, 0);

    // Précondition : `changeStatusRetour` part d'une DI terminée.
    await withDb((db) =>
        db.collection('dis').updateOne({ _id: DI_ID }, { $set: { status: 'FINISHED' } }),
    );
    const r = await mutate(
        request,
        `mutation { changeStatusRetour(_id: "${DI_ID}", reason: "QA ${tag}") { level di { _id status ignoreCount } } }`,
    );
    expect(r.data.changeStatusRetour.level).toBe(1);

    // Le miroir est remis à zéro — c'est ce vidage qui a détruit les documents
    // des DI héritées, faute de ligne de cycle pour les recueillir.
    const di: any = await withDb((db) => db.collection('dis').findOne({ _id: DI_ID }));
    expect(di.ignoreCount).toBe(1);
    for (const f of DOC_FIELDS) expect(di?.[f] ?? null, `${f} aurait dû être vidé du miroir`).toBeNull();

    // …et le dossier du cycle 0 a TOUT gardé, à l'identique.
    const after: any = await cycleRow(DI_ID, 0);
    for (const f of DOC_FIELDS) expect(after?.[f]).toBe(before?.[f]);
    expect(after?.closedAt, 'le cycle sortant doit être figé').toBeTruthy();
});

test('4 — un document déposé au RETOUR va sur le cycle 1, sans toucher le cycle 0', async ({ request }) => {
    const c0Before: any = await cycleRow(DI_ID, 0);

    await mutate(request, `mutation { addBl(_id: "${DI_ID}", pdf: "${PDF_B64}") { _id } }`);

    const c1: any = await cycleRow(DI_ID, 1);
    expect(c1?.bon_de_livraison, 'BL absent de la ligne de cycle 1').toBeTruthy();

    const c0After: any = await cycleRow(DI_ID, 0);
    expect(c0After?.bon_de_livraison).toBe(c0Before?.bon_de_livraison);
    // Le BL du retour est un AUTRE fichier que celui de l'origine.
    expect(c1.bon_de_livraison).not.toBe(c0After.bon_de_livraison);
});

test('5 — la modale sépare alors origine et retour', async ({ page }) => {
    const c0: any = await cycleRow(DI_ID, 0);
    const c1: any = await cycleRow(DI_ID, 1);
    const di: any = await withDb((db) => db.collection('dis').findOne({ _id: DI_ID }));

    // Précondition : le trombone n'apparaît que sur une DI en clôture
    // (`canAffectFiles`) ; après le retour la DI est en RETOUR1.
    await withDb((db) =>
        db.collection('dis').updateOne({ _id: DI_ID }, { $set: { status: 'WAITING_FACTURE' } }),
    );

    await page.goto('/tickets/ticket/ticket-list');
    await page.evaluate(() =>
        document.getElementById('webpack-dev-server-client-overlay')?.remove(),
    );

    // La liste est paginée (10 lignes sur 320+) et la DI n'est pas forcément en
    // tête : on la cherche par sa référence plutôt que de parier sur le tri.
    const search = page.locator('input[placeholder*="herch"]').first();
    await search.waitFor({ timeout: 25_000 });
    await search.fill(di._idnum);

    const row = page.locator('tr', { hasText: di._idnum });
    await expect(row).toBeVisible({ timeout: 25_000 });
    await row.locator('button:has(.pi-paperclip)').click();
    await expect(page.locator('.af-modal')).toBeVisible({ timeout: 10_000 });

    // « Fichiers principaux » = les documents du CYCLE 0, et eux seuls.
    const mainHrefs = await page
        .locator('.af-status-card__link')
        .evaluateAll((els) =>
            els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''),
        );
    expect(mainHrefs).toContain(String(c0.bon_de_livraison));
    expect(mainHrefs).not.toContain(String(c1.bon_de_livraison));

    // La frise ne montre que le retour 1 — jamais un « Retour N°0 ».
    await expect(page.locator('.af-tl-node')).toHaveText(['1']);
    const retourHrefs = await page
        .locator('.af-tl-docs a')
        .evaluateAll((els) =>
            els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''),
        );
    expect(retourHrefs).toContain(String(c1.bon_de_livraison));
    expect(retourHrefs).not.toContain(String(c0.bon_de_livraison));
});
