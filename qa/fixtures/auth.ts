import { test as base } from '@playwright/test';
import { GqlRecorder } from '../utils/graphql';
import { authFile } from '../utils/auth';

/**
 * Extended `test` for the suite.
 *
 *  - `gql`: a GraphQL recorder auto-attached to the page. Use it to assert on
 *    response `errors`/`data` and to detect duplicate mutations — never trust
 *    the HTTP 200 alone.
 *
 * Role-scoped sessions: per spec, reuse a persisted login with
 *   test.use({ storageState: authFile('MANAGER') })
 * (the files are produced by tests/auth.setup.ts → the `setup` project).
 */
export const test = base.extend<{ gql: GqlRecorder }>({
  gql: async ({ page }, use) => {
    const recorder = new GqlRecorder(page);
    await use(recorder);
  },
});

export { expect } from '@playwright/test';
export { authFile };
