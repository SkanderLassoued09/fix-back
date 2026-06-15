import { test, expect, request as pwRequest } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
  getAuthToken,
  gql,
  gqlRaw,
  createCompany,
  deleteCompany,
  isServerCrash,
  minimalCompany,
} from "./_helpers";
import { withDb } from "../utils/mongo";

/**
 * Company — API input-health (GraphQL). Security is OUT of scope (a valid token
 * is used only to reach the endpoints). See COMPANY_QA_REPORT.md.
 *
 * GOLD RULE (strict, asserted on every invalid input): the server must never
 * crash — no HTTP >= 500 and no `INTERNAL_SERVER_ERROR`. A crash = missing
 * validation = bug.
 *
 * Validation GAPS (input accepted that should be rejected) are collected and
 * printed at the end rather than failing the suite, because closing them needs
 * a coordinated front (variables) + back (ValidationPipe) change — see report.
 */

const TAG = Date.now().toString(36);
const createdIds: string[] = [];
const gaps: string[] = [];

let api: APIRequestContext;
let token: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  api = await pwRequest.newContext();
  token = await getAuthToken(api);
});

test.afterAll(async () => {
  // Hard-delete the QA rows we created (removeCompany only soft-deletes).
  await withDb(async (db) => {
    if (createdIds.length) {
      await db.collection("companies").deleteMany({ _id: { $in: createdIds } });
    }
    await db
      .collection("companies")
      .deleteMany({ name: { $regex: `^QA Co ${TAG}` } });
  });
  await api.dispose();
  if (gaps.length) {
    console.log(
      "\n──── VALIDATION GAPS (accepted invalid input — see report) ────\n" +
        gaps.map((g) => "  • " + g).join("\n") +
        "\n───────────────────────────────────────────────────────────────",
    );
  }
});

// ─────────────────────────── Valid path ───────────────────────────
test.describe("createCompany — valid path", () => {
  test("minimal required payload → returns entity with _id", async () => {
    const r = await createCompany(api, token, minimalCompany(`${TAG}-min`));
    expect(isServerCrash(r), JSON.stringify(r.errors)).toBe(false);
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(0);
    expect(r.data?.createCompany?._id).toBeTruthy();
    if (r.data?.createCompany?._id) createdIds.push(r.data.createCompany._id);
  });

  test("full valid payload → fields persist, no sensitive leak", async () => {
    const input = {
      ...minimalCompany(`${TAG}-full`),
      email: "contact@qa.tn",
      fax: "+21671000000",
      webSiteLink: "https://qa.tn",
      Exoneration: "Oui",
      activiteSecondaire: "Maintenance",
      serviceAchat: {
        name: "Achat QA",
        email: "achat@qa.tn",
        phone: "+21620000000",
      },
    };
    const r = await createCompany(api, token, input);
    expect(isServerCrash(r), JSON.stringify(r.errors)).toBe(false);
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(0);
    const id = r.data?.createCompany?._id;
    expect(id).toBeTruthy();
    createdIds.push(id);

    const read = await gql(
      api,
      token,
      `query($id:String!){ findOneCompany(_id:$id){ _id name email webSiteLink Exoneration activitePrincipale raisonSociale } }`,
      { id },
    );
    expect(isServerCrash(read)).toBe(false);
    expect(read.data?.findOneCompany?.email).toBe("contact@qa.tn");
    expect(read.data?.findOneCompany?.webSiteLink).toBe("https://qa.tn");
    // No password / internal fields exposed on the type.
    expect(JSON.stringify(read.data?.findOneCompany)).not.toContain("password");
  });

  test("updateCompany existing → 200-equivalent, value persisted", async () => {
    const c = await createCompany(api, token, minimalCompany(`${TAG}-upd`));
    const id = c.data?.createCompany?._id;
    expect(id).toBeTruthy();
    createdIds.push(id);

    const r = await gql(
      api,
      token,
      `mutation($i:UpdateCompanyInput!){ updateCompany(updateCompanyInput:$i){ _id address } }`,
      { i: { _id: id, address: "Adresse modifiée QA" } },
    );
    expect(isServerCrash(r), JSON.stringify(r.errors)).toBe(false);
    expect(r.data?.updateCompany?.address).toBe("Adresse modifiée QA");
  });
});

// ───────── Invalid input — must be REJECTED (no crash, no row created) ──────
// After the validation-hardening pass these are rejected with a structured
// error (the 7 former "gaps" + the GraphQL-native rejections). Unicode is
// valid and must still be accepted.
test.describe("createCompany — invalid input is rejected, never crashes", () => {
  const base = () => minimalCompany(`${TAG}-inv`);

  const invalids: Array<{ label: string; mutate: (i: any) => any }> = [
    {
      label: "missing required (raisonSociale absent)",
      mutate: (i) => {
        delete i.raisonSociale;
        return i;
      },
    },
    {
      label: 'empty string on required (raisonSociale="")',
      mutate: (i) => ({ ...i, raisonSociale: "" }),
    },
    {
      label: 'whitespace-only on required (raisonSociale="   ")',
      mutate: (i) => ({ ...i, raisonSociale: "   " }),
    },
    {
      label: "malformed email",
      mutate: (i) => ({ ...i, email: "not-an-email" }),
    },
    {
      label: "website not a URL",
      mutate: (i) => ({ ...i, webSiteLink: "not a url" }),
    },
    {
      label: "exoneration out of enum (≠ Oui/Non)",
      mutate: (i) => ({ ...i, Exoneration: "MAYBE" }),
    },
    {
      label: "over-length (10k chars) on name",
      mutate: (i) => ({ ...i, name: "x".repeat(10000) }),
    },
    {
      label: "unknown / extra field",
      mutate: (i) => ({ ...i, bogusField: "x" }),
    },
    {
      label: "explicit null on required (address=null)",
      mutate: (i) => ({ ...i, name: null }),
    },
    {
      label: "wrong type (name = number)",
      mutate: (i) => ({ ...i, name: 12345 }),
    },
    {
      label: "invalid sub-object (serviceAchat.email malformed)",
      mutate: (i) => ({
        ...i,
        serviceAchat: { name: "X", email: "bad", phone: "abc" },
      }),
    },
  ];

  for (const { label, mutate } of invalids) {
    test(`rejected: ${label}`, async () => {
      const input = mutate(base());
      const r = await gql(
        api,
        token,
        `mutation($i: CreateCompanyInput!){ createCompany(createCompanyInput:$i){ _id } }`,
        { i: input },
      );
      // never a crash …
      expect(
        isServerCrash(r),
        `SERVER CRASH on "${label}": status=${r.status} code=${r.code} ${JSON.stringify(r.errors)}`,
      ).toBe(false);
      // … rejected with a structured error …
      expect(
        r.errors.length,
        `"${label}" should be REJECTED but was accepted/empty: ${JSON.stringify(r.body)}`,
      ).toBeGreaterThan(0);
      // … and no row created.
      const acceptedId = r.data?.createCompany?._id;
      if (acceptedId) createdIds.push(acceptedId);
      expect(
        acceptedId,
        `"${label}" created a row despite being invalid`,
      ).toBeFalsy();
    });
  }

  test("unicode / emoji in fields is accepted (valid input)", async () => {
    const r = await gql(
      api,
      token,
      `mutation($i: CreateCompanyInput!){ createCompany(createCompanyInput:$i){ _id } }`,
      {
        i: {
          ...base(),
          name: "🏢 Société ✓ Δοκιμή",
          raisonSociale: "🏢 Société",
        },
      },
    );
    expect(isServerCrash(r), JSON.stringify(r.errors)).toBe(false);
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(0);
    const id = r.data?.createCompany?._id;
    expect(id).toBeTruthy();
    if (id) createdIds.push(id);
  });
});

// ─────────────────── Not-found / delete contract ───────────────────
test.describe("delete / not-found contract", () => {
  test("removeCompany on a non-existent id → structured error, not a crash", async () => {
    const r = await deleteCompany(api, token, "does-not-exist-xyz");
    expect(
      isServerCrash(r),
      `removeCompany(nonexistent) crashed: status=${r.status} code=${r.code} ${JSON.stringify(r.errors)}`,
    ).toBe(false);
  });

  test("double delete → still a clean structured error, not a crash", async () => {
    const c = await createCompany(api, token, minimalCompany(`${TAG}-del`));
    const id = c.data?.createCompany?._id;
    expect(id).toBeTruthy();
    createdIds.push(id);

    const first = await deleteCompany(api, token, id);
    expect(isServerCrash(first)).toBe(false);
    const second = await deleteCompany(api, token, id);
    expect(
      isServerCrash(second),
      `double delete crashed: ${JSON.stringify(second.errors)}`,
    ).toBe(false);
  });
});

// ─────────────────── Transport-level robustness ───────────────────
test.describe("transport", () => {
  test("malformed JSON body → 400, not 500", async () => {
    const r = await gqlRaw(api, token, "{ this is not json ");
    expect(r.status, r.text.slice(0, 200)).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  test("wrong Content-Type (text/plain) → 4xx, not 500", async () => {
    const r = await gqlRaw(
      api,
      token,
      JSON.stringify({ query: "{ __typename }" }),
      "text/plain",
    );
    expect(r.status).toBeLessThan(500);
  });

  test("findAllCompany list → returns an array + total", async () => {
    const r = await gql(
      api,
      token,
      `query{ findAllCompany(PaginationConfig:{ rows: 5, first: 0 }){ companyRecords{ _id name } totalCompanyRecord } }`,
    );
    expect(isServerCrash(r), JSON.stringify(r.errors)).toBe(false);
    expect(Array.isArray(r.data?.findAllCompany?.companyRecords)).toBe(true);
    expect(typeof r.data?.findAllCompany?.totalCompanyRecord).toBe("number");
  });
});
