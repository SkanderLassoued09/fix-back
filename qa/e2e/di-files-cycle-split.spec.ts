import { test, expect } from '@playwright/test';
import { authFile } from '../utils/auth';
import { withDb } from '../utils/mongo';
import { techId } from '../utils/accounts';

/**
 * « Affectation des Fichiers » — séparation CYCLE 0 / RETOURS, dans l'UI réelle.
 *
 * Le bloc « Fichiers principaux » doit montrer les documents du FLUX D'ORIGINE
 * (cycle 0) ; la frise « Historique des retours » uniquement les cycles ≥ 1.
 *
 * Les deux moitiés étaient fausses de façon complémentaire :
 *  - `Di.*` n'est qu'un MIROIR du cycle COURANT, donc sur une DI en retour le
 *    bloc « principaux » montrait les fichiers DU RETOUR ;
 *  - `getAllLogsByDi` renvoie AUSSI la ligne du cycle 0, que la frise rendait
 *    telle quelle → un « Retour N°0 » qui n'existe pas.
 *
 * On seed une DI en RETOUR 1, éligible au trombone (`WAITING_FACTURE`), dont les
 * documents diffèrent VISIBLEMENT d'un cycle à l'autre (`-c0` vs `-c1`).
 */

const TICKET_LIST = '/tickets/ticket/ticket-list';
const tag = `cyc_${Date.now().toString(36)}`;
const diId = `DI_${tag}`;
const idnum = `CYC-${tag.toUpperCase()}`;
const url = (kind: string, cycle: number) =>
    `https://drive.google.com/${kind}-c${cycle}.pdf`;

let TECH_ID = '';

test.use({ storageState: authFile('ADMIN_MANAGER') });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    TECH_ID = await withDb(techId);
    await withDb(async (db) => {
        const now = new Date();
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: 'QA séparation cycle 0 / retours',
            status: 'WAITING_FACTURE',
            ignoreCount: 1,
            can_be_repaired: true,
            contain_pdr: false,
            array_composants: [],
            createdBy: TECH_ID,
            current_workers_ids: [TECH_ID],
            current_roles: ['Manager'],
            isDeleted: false,
            // Le MIROIR décrit le cycle COURANT (le retour) — c'est exactement ce
            // qui ne doit PAS apparaître dans « Fichiers principaux ».
            devis: url('devis', 1),
            bon_de_commande: url('bc', 1),
            bon_de_livraison: url('bl', 1),
            statusUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
        });
        await db.collection('logsdis').insertMany([
            {
                _id: `log-${diId}-0`,
                _idDi: diId,
                idIgnore: 0,
                devis: url('devis', 0),
                bon_de_commande: url('bc', 0),
                bon_de_livraison: url('bl', 0),
                facture: url('facture', 0),
                closedAt: now,
                createdAt: now,
                updatedAt: now,
            },
            {
                _id: `log-${diId}-1`,
                _idDi: diId,
                idIgnore: 1,
                devis: url('devis', 1),
                bon_de_commande: url('bc', 1),
                bon_de_livraison: url('bl', 1),
                createdAt: now,
                updatedAt: now,
            },
        ]);
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteOne({ _id: diId });
        await db.collection('logsdis').deleteMany({ _idDi: diId });
    });
});

test('« Fichiers principaux » = cycle 0, « Historique des retours » = cycles ≥ 1', async ({
    page,
}) => {
    await page.goto(TICKET_LIST);
    // L'overlay du dev-server capte les clics (et peut être périmé) — cf. README.
    await page.evaluate(() =>
        document.getElementById('webpack-dev-server-client-overlay')?.remove(),
    );

    const row = page.locator('tr', { hasText: idnum });
    await expect(row).toBeVisible({ timeout: 25_000 });
    await row.locator('button:has(.pi-paperclip)').click();
    await expect(page.locator('.af-modal')).toBeVisible({ timeout: 10_000 });

    // ── Fichiers principaux : les 4 documents du CYCLE 0 ────────────────────
    const mainLinks = page.locator('.af-status-card__link');
    await expect(mainLinks).toHaveCount(4, { timeout: 10_000 });
    const mainHrefs = await mainLinks.evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''),
    );
    for (const kind of ['devis', 'bc', 'bl', 'facture']) {
        expect(mainHrefs.some((h) => h.includes(`${kind}-c0`))).toBe(true);
    }
    // Aucun document du RETOUR ne doit fuiter dans le bloc principal.
    expect(mainHrefs.some((h) => h.includes('-c1'))).toBe(false);
    await expect(page.locator('.af-count-pill').first()).toHaveText('4');

    // ── Historique des retours : le cycle 1, et lui seul ────────────────────
    const nodes = page.locator('.af-tl-node');
    await expect(nodes).toHaveCount(1);
    await expect(nodes.first()).toHaveText('1'); // jamais « 0 »
    await expect(page.locator('.af-tl-card__title')).toHaveText('Retour N°1');

    const retourHrefs = await page
        .locator('.af-tl-docs a')
        .evaluateAll((els) =>
            els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''),
        );
    expect(retourHrefs.length).toBeGreaterThan(0);
    expect(retourHrefs.every((h) => h.includes('-c1'))).toBe(true);
    expect(retourHrefs.some((h) => h.includes('-c0'))).toBe(false);
});
