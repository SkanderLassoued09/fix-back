import { Page, Response, APIRequestContext, expect } from '@playwright/test';

/** Backend GraphQL endpoint (not the :4200 frontend baseURL). Matches the app's
 *  own apiUrl; proven working in the Area 4/5 API tests. */
export const GRAPHQL_URL = 'http://localhost:3000/graphql';

export interface GqlPostResult {
  httpStatus: number;
  data: any;
  errors: any[] | null;
  /** Concatenated error messages, lower-cased, for easy matching. */
  errorText: string;
}

/**
 * Raw GraphQL POST for backend permission probes — bypasses the UI so we can
 * test what the server enforces (or doesn't) for a given token. Pass no token
 * to probe unauthenticated access.
 */
export async function gqlPost(
  request: APIRequestContext,
  query: string,
  token?: string,
): Promise<GqlPostResult> {
  const resp = await request.post(GRAPHQL_URL, {
    data: { query },
    headers: {
      // QA marker → backend logs the error but never pushes it to Discord.
      'x-test-run': '1',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await resp.json().catch(() => ({}));
  const errors = Array.isArray(body?.errors) ? body.errors : null;
  return {
    httpStatus: resp.status(),
    data: body?.data ?? null,
    errors,
    errorText: JSON.stringify(errors ?? []).toLowerCase(),
  };
}

/**
 * GraphQL-aware capture helper.
 *
 * The Fixtronix backend is GraphQL: every call is POST .../graphql and returns
 * HTTP 200 even on failure. NEVER judge success by status code — judge by the
 * response `errors` array and whether `data` is present.
 *
 * Most of the app's operations are hand-built anonymous gql strings (no
 * operationName), so we also parse the query text to recover the root field
 * (e.g. `login`, `searchDi`, `createDi`) for matching/grouping.
 */
export interface GqlRecord {
  opKind: 'query' | 'mutation' | 'subscription' | 'unknown';
  /** Explicit operationName if the document declared one (often null here). */
  opName: string | null;
  /** First selected field — the practical identifier for anonymous ops. */
  rootField: string | null;
  /** Raw query document string (these are hand-built with values inlined). */
  query: string | null;
  variables: unknown;
  httpStatus: number;
  hasErrors: boolean;
  errors: unknown[] | null;
  data: unknown;
  dataKeys: string[];
  url: string;
}

function parseQuery(query: string | undefined): {
  opKind: GqlRecord['opKind'];
  rootField: string | null;
} {
  if (!query) return { opKind: 'unknown', rootField: null };
  const kindMatch = query.match(/\b(query|mutation|subscription)\b/);
  // An anonymous "{ ... }" document is a query by spec.
  const opKind = (kindMatch?.[1] as GqlRecord['opKind']) ?? 'query';
  const braceIdx = query.indexOf('{');
  const afterBrace = braceIdx >= 0 ? query.slice(braceIdx + 1) : query;
  const fieldMatch = afterBrace.match(/([A-Za-z_][A-Za-z0-9_]*)/);
  return { opKind, rootField: fieldMatch?.[1] ?? null };
}

export class GqlRecorder {
  readonly records: GqlRecord[] = [];

  constructor(page: Page, private readonly endpointFragment = '/graphql') {
    page.on('response', (resp) => {
      // Fire-and-forget; never let recording break a test.
      void this.capture(resp).catch(() => undefined);
    });
  }

  private async capture(resp: Response): Promise<void> {
    const req = resp.request();
    if (req.method() !== 'POST') return;
    if (!resp.url().includes(this.endpointFragment)) return;

    let post: { query?: string; variables?: unknown; operationName?: string } = {};
    try {
      post = JSON.parse(req.postData() || '{}');
    } catch {
      /* not JSON — ignore */
    }

    let body: { data?: unknown; errors?: unknown[] } | undefined;
    try {
      body = await resp.json();
    } catch {
      /* non-JSON response body */
    }

    const { opKind, rootField } = parseQuery(post.query);
    const errors = Array.isArray(body?.errors) ? body!.errors! : null;
    const data = body?.data ?? undefined;

    this.records.push({
      opKind,
      opName: post.operationName ?? null,
      rootField,
      query: post.query ?? null,
      variables: post.variables ?? null,
      httpStatus: resp.status(),
      hasErrors: !!errors && errors.length > 0,
      errors,
      data,
      dataKeys: data && typeof data === 'object' ? Object.keys(data as object) : [],
      url: resp.url(),
    });
  }

  /** All records whose root field matches (e.g. 'login', 'createDi'). */
  byField(field: string): GqlRecord[] {
    return this.records.filter((r) => r.rootField === field);
  }

  /** Records that came back with a non-empty `errors` array (true failures). */
  withErrors(): GqlRecord[] {
    return this.records.filter((r) => r.hasErrors);
  }

  /** Detect duplicate identical operations (same kind+field+variables). */
  duplicates(): Array<{ key: string; count: number }> {
    const counts = new Map<string, number>();
    for (const r of this.records) {
      const key = `${r.opKind}:${r.rootField}:${JSON.stringify(r.variables)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([key, count]) => ({ key, count }));
  }

  clear(): void {
    this.records.length = 0;
  }
}

/** Assert no GraphQL operation returned an `errors` array. */
export function assertNoGqlErrors(recorder: GqlRecorder): void {
  const bad = recorder.withErrors().map((r) => ({ field: r.rootField, errors: r.errors }));
  expect(bad, `Unexpected GraphQL errors:\n${JSON.stringify(bad, null, 2)}`).toHaveLength(0);
}

/** Assert a given user action fired a mutation only once (no double-submit). */
export function assertNoDuplicateMutations(recorder: GqlRecorder): void {
  const dups = recorder.duplicates();
  expect(dups, `Duplicate operations fired:\n${JSON.stringify(dups, null, 2)}`).toHaveLength(0);
}
