import { test, expect } from '../../fixtures/auth';
import { tokenFor } from '../../utils/auth';
import { gqlPost } from '../../utils/graphql';
import type { APIRequestContext } from '@playwright/test';

/**
 * Area 8 — File uploads.
 * Documents are uploaded as base64 inside GraphQL mutations (addDevis/addBl/...),
 * decoded to disk under <project>/docs/<random>.<ext>, and served by
 * ServeStaticModule WITH NO serveRoot prefix — i.e. at the web root and with NO
 * auth. This test uploads a devis and confirms the round-trip AND that the file
 * is publicly fetchable without a token (confirms known-issues S7).
 */

const FILE_BASE = 'http://localhost:3000/'; // ServeStatic serves docs/ at the root

async function makeDi(request: APIRequestContext, token: string, clientId: string) {
  const r = await gqlPost(
    request,
    `mutation { createDi(createDiInput: { title: "QA-UP-${Date.now()}", status: "CREATED", typeClient: "CLIENT", client_id: "${clientId}" }) { _id } }`,
    token,
  );
  return r.data?.createDi?._id as string;
}

test('A8.1 uploaded devis round-trips and is publicly reachable without auth (confirms S7)', async ({ request }) => {
  const token = tokenFor('ADMIN_MANAGER');

  const clientRes = await gqlPost(request, `{ getAllClient { _id } }`, token);
  const clientId = clientRes.data?.getAllClient?.[0]?._id;
  expect(clientId, 'a client exists to attach the DI to').toBeTruthy();

  const diId = await makeDi(request, token, clientId);
  expect(diId, 'DI created').toBeTruthy();

  try {
    // Upload a recognizable "PDF" as a base64 data URL (addDevis is not guarded).
    const marker = `fixtronix-qa-${Date.now()}`;
    const content = `%PDF-1.4 ${marker}`;
    const dataUrl = `data:application/pdf;base64,${Buffer.from(content).toString('base64')}`;
    const up = await gqlPost(request, `mutation { addDevis(_id: "${diId}", pdf: "${dataUrl}") { _id } }`, token);
    expect(up.errors, 'addDevis has no GraphQL errors').toBeNull();

    // Read back the stored filename.
    const di = await gqlPost(request, `{ getDiById(_id: "${diId}") { di { _id devis } } }`, token);
    const devis = di.data?.getDiById?.di?.devis as string;
    expect(devis, 'DI.devis holds the stored filename').toBeTruthy();
    expect(devis, 'filename keeps the .pdf extension').toMatch(/\.pdf$/i);

    // Fetch the file with NO Authorization header → must be publicly served.
    const fileResp = await request.get(`${FILE_BASE}${devis}`);
    expect(fileResp.status(), 'static file served at the web root, unauthenticated').toBe(200);
    const body = await fileResp.text();
    expect(body, 'served bytes match what was uploaded').toContain(marker);

    await test.info().attach('A8.1-public-file.txt', {
      body: `GET ${FILE_BASE}${devis} (no auth) -> ${fileResp.status()}`,
      contentType: 'text/plain',
    });
  } finally {
    await gqlPost(request, `mutation { deleteDi(_id: "${diId}") { _id isDeleted } }`, token);
  }
});
