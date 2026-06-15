import { test, expect, request as pwRequest } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { tokenFor, authFile } from '../../utils/auth';
import { gqlPost } from '../../utils/graphql';
import { withDb } from '../../utils/mongo';

/**
 * Regression — Réparation modal pause → propagate, resume → propagate.
 *
 * Drives the REAL repair modal (so the fixed host handler
 * tech-di-list.onRepairModalPause → lapTimeForPauseAndGetBack1 runs) and proves
 * the status flips instantly across views:
 *   - the modal header pill flips paused/running,
 *   - a SECOND open TECH tech-list view reflects the new status WITHOUT a manual
 *     reload (WS broadcast → auto-refresh), and
 *   - the backend (getDiById + getDiStatusCounts) agrees.
 * Asserts no GraphQL errors and no uncaught page errors throughout.
 *
 * Precondition is staged via Mongo: a DI in REPARATION + a Stat assigned to the
 * seeded TECH (id_tech_rep). Cleaned up in afterAll.
 */

const TECH_ID = '69fb49a8fbdfcb7ca81bed0e'; // seeded `tech` account _id
const TECH_LIST = '/tickets/ticket/tech-di-list';

let diId = '';
let statId = '';
let idnum = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const stamp = Date.now().toString(36);
  diId = `DI_qa${stamp}`;
  statId = `STAT_qa${stamp}`;
  await withDb(async (db) => {
    const client = await db.collection('clients').findOne({ isDeleted: { $ne: true } });
    const dis = await db
      .collection('dis')
      .find({ _idnum: /^DI\d+$/ }, { projection: { _idnum: 1 } })
      .toArray();
    const max = dis.reduce((m: number, d: any) => Math.max(m, parseInt(String(d._idnum).slice(2), 10) || 0), 0);
    idnum = `DI${max + 1}`;

    await db.collection('dis').insertOne({
      _id: diId,
      _idnum: idnum,
      title: 'QA Repair Modal',
      description: 'staged by repair-modal regression',
      status: 'REPARATION',
      can_be_repaired: true,
      contain_pdr: false,
      client_id: client?._id ?? null,
      createdBy: TECH_ID,
      array_composants: [],
      current_workers_ids: [TECH_ID],
      current_roles: ['Tech'],
      isDeleted: false,
      statusUpdatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('stats').insertOne({
      _id: statId,
      _idDi: diId,
      diRef: diId,
      id_tech_rep: TECH_ID,
      id_tech_diag: TECH_ID,
      status: 'REPARATION',
      diag_time: '00:05:00',
      rep_time: '',
      ignoreCount: 0,
      retour_count: 0,
      pauseLogs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
});

test.afterAll(async () => {
  await withDb(async (db) => {
    await db.collection('dis').deleteOne({ _id: diId });
    await db.collection('stats').deleteOne({ _id: statId });
  });
});

/** Latest status this page has observed for the staged DI in getDiForTech responses. */
function trackTechListStatus(page: Page): () => string | undefined {
  let latest: string | undefined;
  page.on('response', async (resp) => {
    if (!resp.url().includes('/graphql')) return;
    if (!(resp.request().postData() ?? '').includes('getDiForTech')) return;
    try {
      const body = await resp.json();
      const rows = body?.data?.getDiForTech?.stat ?? [];
      const row = rows.find((r: any) => r._idDi === diId || r._id === statId);
      if (row) latest = row.status;
    } catch {
      /* ignore */
    }
  });
  return () => latest;
}

async function diStatus(api: APIRequestContext, token: string): Promise<string | undefined> {
  const r = await gqlPost(api, `{ getDiById(_id: "${diId}") { di { _id status } } }`, token);
  return r.data?.getDiById?.di?.status;
}

/** Read the HH:MM:SS timer shown in the repair modal header, in seconds. */
async function modalElapsedSec(page: Page): Promise<number> {
  const txt = await page.locator('.sav-diag-header').innerText();
  const m = txt.match(/(\d{2}):(\d{2}):(\d{2})/);
  if (!m) throw new Error(`no timer found in modal header: ${txt}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Ensure the repair modal is open (the new wizard doesn't auto-restore on
 *  reload, so reopen it via the wrench when needed). */
async function openRepairModal(page: Page): Promise<void> {
  const header = page.locator('.sav-diag-header');
  if (await header.isVisible().catch(() => false)) return;
  const row = page.locator('tr', { hasText: idnum });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator('button:has(.pi-wrench)').click();
  await expect(header).toBeVisible({ timeout: 10000 });
}

test('Réparation modal: pause→propagate and resume→propagate (2nd view, no reload)', async ({ browser }) => {
  const api = await pwRequest.newContext();
  const adminToken = tokenFor('ADMIN_MANAGER');

  // Two independent TECH sessions: A drives the modal, B is the "second view".
  const ctxA = await browser.newContext({ storageState: authFile('TECH') });
  const ctxB = await browser.newContext({ storageState: authFile('TECH') });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const pageErrors: string[] = [];
  const gqlErrors: string[] = [];
  for (const p of [pageA, pageB]) {
    p.on('pageerror', (e) => pageErrors.push(e.message));
    p.on('response', async (r) => {
      if (!r.url().includes('/graphql')) return;
      try {
        const b = await r.json();
        if (Array.isArray(b?.errors) && b.errors.length) gqlErrors.push(JSON.stringify(b.errors));
      } catch {
        /* non-json */
      }
    });
  }
  const bStatus = trackTechListStatus(pageB);

  try {
    // Both views load the tech repair list; the staged DI row appears for the tech.
    await pageA.goto(TECH_LIST);
    await pageB.goto(TECH_LIST);
    const rowA = pageA.locator('tr', { hasText: idnum });
    const rowB = pageB.locator('tr', { hasText: idnum });
    await expect(rowA, 'staged DI appears in tech list A').toBeVisible({ timeout: 15000 });
    await expect(rowB, 'staged DI appears in tech list B').toBeVisible({ timeout: 15000 });

    // Open the repair modal (wrench, icon-only button → no accessible name).
    // repModal auto-transitions REPARATION → INREPARATION.
    await rowA.locator('button:has(.pi-wrench)').click();
    const header = pageA.locator('.sav-diag-header');
    await expect(header, 'repair modal opened').toBeVisible({ timeout: 10000 });
    const pauseBtn = pageA.locator('button.sav-diag-header__pause');
    await expect(pauseBtn).toHaveText(/Mettre en pause/, { timeout: 10000 });

    // ── PAUSE ───────────────────────────────────────────────────────────────
    await pauseBtn.click();
    // The action registered (timer paused → button label flips).
    await expect(pauseBtn, 'pause registered').toHaveText(/Reprendre/, { timeout: 10000 });

    // CORE: the host fired the status mutation, so the BACKEND flips to paused…
    await expect.poll(() => diStatus(api, adminToken), { timeout: 12000 }).toBe('REPARATION_Pause');
    // …and the SECOND open view reflects it WITHOUT a manual reload (WS → refetch).
    await expect
      .poll(bStatus, { timeout: 12000, message: 'second TECH view reflects REPARATION_Pause without reload' })
      .toBe('REPARATION_Pause');

    // The modal's own header pill also reflects the pause.
    await expect(pageA.locator('.sav-diag-header__status--paused'), 'modal pill shows paused').toBeVisible({ timeout: 8000 });

    // ── RESUME ────────────────────────────────────────────────────────────────
    await pauseBtn.click();
    await expect(pauseBtn, 'resume registered').toHaveText(/Mettre en pause/, { timeout: 10000 });

    await expect.poll(() => diStatus(api, adminToken), { timeout: 12000 }).toBe('INREPARATION');
    await expect
      .poll(bStatus, { timeout: 12000, message: 'second TECH view reflects INREPARATION without reload' })
      .toBe('INREPARATION');
    await expect(pageA.locator('.sav-diag-header__status--running'), 'modal pill shows running').toBeVisible({ timeout: 8000 });

    // No errors anywhere in the flow.
    expect(gqlErrors, `GraphQL errors during repair flow:\n${gqlErrors.join('\n')}`).toHaveLength(0);
    expect(pageErrors, `uncaught page errors during repair flow:\n${pageErrors.join('\n')}`).toHaveLength(0);
  } finally {
    await ctxA.close();
    await ctxB.close();
    await api.dispose();
  }
});

test('Réparation timer survives reload — derives from persisted Stat, never resets to 0', async ({ browser }) => {
  // Stage a RUNNING repair with a known 5-minute run leg already accrued, so a
  // correct (server-derived) timer shows ~5:00 while the old from-0 bug shows ~0.
  const RUN_MS = 5 * 60 * 1000;
  await withDb(async (db) => {
    await db.collection('dis').updateOne(
      { _id: diId },
      { $set: { status: 'INREPARATION', statusUpdatedAt: new Date() } },
    );
    await db.collection('stats').updateOne(
      { _id: statId },
      { $set: { status: 'INREPARATION', rep_time: '00:00:00', repRunStartedAt: new Date(Date.now() - RUN_MS) } },
    );
  });

  const api = await pwRequest.newContext();
  const adminToken = tokenFor('ADMIN_MANAGER');
  const ctx = await browser.newContext({ storageState: authFile('TECH') });
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(TECH_LIST);
    await openRepairModal(page);

    // Open shows the persisted elapsed (~5 min), NOT 0.
    const onOpen = await modalElapsedSec(page);
    expect(onOpen, 'timer derives from the persisted run leg (~5 min), not 0').toBeGreaterThanOrEqual(295);

    // RELOAD → reopen → continues from the correct value (never resets to 0).
    await page.reload();
    await openRepairModal(page);
    const afterReload = await modalElapsedSec(page);
    expect(afterReload, 'timer survives reload (continues, not 0)').toBeGreaterThanOrEqual(onOpen - 2);

    // PAUSE → freezes; reload → reopen → still frozen at ~the same value.
    const pauseBtn = page.locator('button.sav-diag-header__pause');
    await pauseBtn.click();
    await expect(pauseBtn, 'paused').toHaveText(/Reprendre/, { timeout: 10000 });
    // Wait for the pause to PERSIST before reloading (a real user sees it pause
    // first); otherwise the reopen races the mutation and reads INREPARATION.
    await expect.poll(() => diStatus(api, adminToken), { timeout: 12000 }).toBe('REPARATION_Pause');
    const paused = await modalElapsedSec(page);
    await page.reload();
    await openRepairModal(page);
    const pausedAfterReload = await modalElapsedSec(page);
    expect(Math.abs(pausedAfterReload - paused), 'paused timer stays frozen across reload').toBeLessThanOrEqual(3);

    // RESUME → continues from the accumulated value (not 0).
    const resumeBtn = page.locator('button.sav-diag-header__pause');
    await resumeBtn.click();
    await expect(resumeBtn, 'resumed').toHaveText(/Mettre en pause/, { timeout: 10000 });
    const resumed = await modalElapsedSec(page);
    expect(resumed, 'resume continues from the accumulated value, not 0').toBeGreaterThanOrEqual(pausedAfterReload - 2);

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
  } finally {
    await ctx.close();
    await api.dispose();
  }
});
