import { test, expect } from '@playwright/test';
import { authFile, tokenFor } from '../utils/auth';
import { withDb } from '../utils/mongo';

/**
 * Bug probe: open the Coordinator page, then the Flow modal on a DI with
 * ignoreCount=1, capture EVERY console error / GraphQL error / page error.
 * Output is dumped at the end for triage.
 */

const COORDINATOR = '/tickets/ticket/coordinator-di-list';
const TECH_ID = '69fb49a8fbdfcb7ca81bed0e';
const tag = `cf_probe_${Date.now().toString(36)}`;
const diId = `DI_${tag}`;
const logId = `LOG_${tag}`;
const idnum = `CFP-${tag.toUpperCase()}`;

test.use({ storageState: authFile('ADMIN_MANAGER') });

test.beforeAll(async () => {
    void tokenFor('ADMIN_MANAGER');
    await withDb(async (db) => {
        await db.collection('dis').insertOne({
            _id: diId,
            _idnum: idnum,
            title: 'QA Coordinator Bug Probe',
            description: 'retour=1 to exercise the new tab UI',
            status: 'PENDING2',
            can_be_repaired: true,
            contain_pdr: false,
            createdBy: TECH_ID,
            current_workers_ids: [TECH_ID],
            current_roles: ['Coordinator'],
            isDeleted: false,
            array_composants: [],
            ignoreCount: 1,
            statusUpdatedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await db.collection('logsdis').insertOne({
            _id: logId,
            _idDi: diId,
            idIgnore: 1,
            status: 'FINISHED',
            comment: 'Retour client : même symptôme',
            current_workers_ids: [TECH_ID],
            array_composants: [],
            createdAt: new Date('2026-06-10T09:00:00Z'),
            updatedAt: new Date(),
        });
    });
});

test.afterAll(async () => {
    await withDb(async (db) => {
        await db.collection('dis').deleteOne({ _id: diId });
        await db.collection('logsdis').deleteOne({ _id: logId });
    });
});

test('probe: open coordinator + open flow modal, dump errors', async ({
    page,
}) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const gqlErrors: string[] = [];

    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('response', async (resp) => {
        if (!resp.url().includes('/graphql')) return;
        try {
            const body = await resp.json();
            if (Array.isArray(body?.errors) && body.errors.length) {
                gqlErrors.push(JSON.stringify(body.errors));
            }
        } catch {
            /* non-JSON */
        }
    });

    await page.goto(COORDINATOR, { waitUntil: 'networkidle' });
    // Let the SPA finish any post-load work.
    await page.waitForTimeout(2000);

    // If the page itself crashed (blank), the row won't appear — surface that.
    const row = page.locator('tr', { hasText: idnum });
    let rowVisible = false;
    try {
        await expect(row).toBeVisible({ timeout: 15_000 });
        rowVisible = true;
    } catch {
        rowVisible = false;
    }

    if (rowVisible) {
        // Open the flow modal — the page exposes a sliders-h icon button.
        const flowBtn = row.locator('button:has(.pi-sliders-h)').first();
        const flowBtnExists = (await flowBtn.count()) > 0;
        if (flowBtnExists) {
            await flowBtn.click();
            await page.waitForTimeout(1500);
        } else {
            // Fallback: click on the first action icon
            await row
                .locator('.sav-actions-cell button, .sav-actions-cell .p-button')
                .first()
                .click()
                .catch(() => undefined);
            await page.waitForTimeout(1500);
        }
    }

    console.log('\n──────── BUG PROBE OUTPUT ────────');
    console.log('row visible :', rowVisible);
    console.log('page errors :', pageErrors.length);
    pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
    console.log('console err :', consoleErrors.length);
    consoleErrors.slice(0, 20).forEach((e, i) => console.log(`  [${i}] ${e}`));
    console.log('gql errors  :', gqlErrors.length);
    gqlErrors.slice(0, 10).forEach((e, i) => console.log(`  [${i}] ${e}`));
    console.log('────────────────────────────────────\n');

    // Surface the first error explicitly to fail the test if anything bad happened.
    expect(pageErrors, 'no unhandled page errors').toHaveLength(0);
    await page.screenshot({ path: '/tmp/cf-after-fix.png', fullPage: false });
});
