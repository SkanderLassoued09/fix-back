import type { APIRequestContext } from '@playwright/test';
import { tokenFor } from '../utils/auth';

/**
 * Company e2e helpers — GraphQL-aware.
 *
 * This backend is GraphQL (apollo-server-express): ONE endpoint `/graphql`,
 * HTTP almost always 200, success/failure judged by the JSON `data`/`errors`.
 * So the prompt's REST framing is reinterpreted:
 *   - "201 + entity"  → response has `data.<op>` with an `_id`, no `errors`.
 *   - "4xx structured" → `errors[]` with a sane `extensions.code`
 *                        (BAD_USER_INPUT / GRAPHQL_VALIDATION_FAILED / BAD_REQUEST).
 *   - "500 / bug"      → HTTP >= 500, OR `errors[].extensions.code ===
 *                        'INTERNAL_SERVER_ERROR'`, OR a non-null-field violation.
 *
 * Auth is used ONLY to reach the endpoints (security is out of scope here).
 */

export const API_URL = process.env.API_URL ?? 'http://localhost:3000';
export const GRAPHQL_URL = `${API_URL}/graphql`;

/** Reuse the existing login: TEST_TOKEN env, else the seeded ADMIN token from
 *  qa/.auth (run `npm run verify:auth` once to (re)create it), else a live
 *  `login` mutation as a last resort. */
export async function getAuthToken(
    request: APIRequestContext,
): Promise<string> {
    if (process.env.TEST_TOKEN) return process.env.TEST_TOKEN;
    try {
        return tokenFor('ADMIN_MANAGER');
    } catch {
        /* fall through to a live login */
    }
    const res = await request.post(GRAPHQL_URL, {
        headers: { 'Content-Type': 'application/json', 'x-test-run': '1' },
        data: {
            query: `mutation($i: LoginAuthInput!){ login(loginAuthInput: $i){ access_token } }`,
            variables: { i: { username: 'skander', password: '123456' } },
        },
    });
    const body = await res.json();
    const token = body?.data?.login?.access_token;
    if (!token) {
        throw new Error(
            'getAuthToken failed: ' + JSON.stringify(body?.errors ?? body),
        );
    }
    return token;
}

export interface GqlResult {
    status: number;
    body: any;
    errors: any[];
    data: any;
    /** first error's extensions.code, if any */
    code?: string;
}

/** POST a GraphQL operation with variables. Never throws on GraphQL errors —
 *  returns a structured result so tests can assert on it. */
export async function gql(
    request: APIRequestContext,
    token: string,
    query: string,
    variables?: any,
): Promise<GqlResult> {
    const res = await request.post(GRAPHQL_URL, {
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'x-test-run': '1', // QA marker → logged but not pushed to Discord
        },
        data: { query, variables },
    });
    const status = res.status();
    let body: any = null;
    try {
        body = await res.json();
    } catch {
        body = { raw: await res.text() };
    }
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    return {
        status,
        body,
        errors,
        data: body?.data ?? null,
        code: errors[0]?.extensions?.code,
    };
}

/** POST a raw body (for malformed-JSON / wrong-content-type cases). */
export async function gqlRaw(
    request: APIRequestContext,
    token: string,
    rawBody: string,
    contentType = 'application/json',
): Promise<{ status: number; text: string }> {
    const res = await request.post(GRAPHQL_URL, {
        headers: {
            'Content-Type': contentType,
            Authorization: `Bearer ${token}`,
            'x-test-run': '1', // QA marker → logged but not pushed to Discord
        },
        data: rawBody,
    });
    return { status: res.status(), text: await res.text() };
}

/** The gold rule: an invalid input must NEVER surface as a server crash. */
export function isServerCrash(r: GqlResult): boolean {
    if (r.status >= 500) return true;
    return r.errors.some(
        (e) => e?.extensions?.code === 'INTERNAL_SERVER_ERROR',
    );
}

/** A minimal VALID CreateCompanyInput (only the DTO-required fields). */
export function minimalCompany(tag: string) {
    return {
        name: `QA Co ${tag}`,
        region: 'TUNIS',
        address: '1 rue de test',
        activitePrincipale: 'Distribution',
        raisonSociale: `QA RS ${tag}`,
        // Per-tag (the backend now rejects an active duplicate MF → CONFLICT).
        mf: `MF-${tag}`,
        rne: 'B123456',
    };
}

/** Create a company via variables (clean path, bypasses the front's string
 *  interpolation) and return its _id (or null). */
export async function createCompany(
    request: APIRequestContext,
    token: string,
    input: any,
): Promise<GqlResult> {
    return gql(
        request,
        token,
        `mutation($i: CreateCompanyInput!){ createCompany(createCompanyInput: $i){ _id name } }`,
        { i: input },
    );
}

export async function deleteCompany(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<GqlResult> {
    return gql(
        request,
        token,
        `mutation($id: String!){ removeCompany(_id: $id){ _id isDeleted } }`,
        { id },
    );
}
