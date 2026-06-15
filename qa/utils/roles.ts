/**
 * The 6 Fixtronix roles and their seeded test accounts (per Phase-2 brief E5).
 * All passwords are `123456`.
 *
 * ⚠️ The COORDINATOR account's role is stored in the DB as the misspelling
 *    "COORDIANTOR" — the codebase uses this spelling consistently, so it is the
 *    CORRECT expected value, NOT a bug. Match it exactly in assertions.
 *
 * There is also a dead dummy account (username "testtech", id "tech123") with an
 * invalid password hash — it cannot log in and is intentionally excluded here.
 */
export interface RoleAccount {
  /** Stable logical key used for storageState filenames and test titles. */
  key: string;
  username: string;
  password: string;
  /** Role string as stored in the DB / written to localStorage('role'). */
  expectedRole: string;
  /** The role's primary DI list route (used by later navigation tests). */
  primaryTicketRoute: string;
  /** Whether the role's menu exposes the dashboard (route is reachable regardless). */
  hasDashboardMenu: boolean;
}

const PW = '123456';

export const ROLE_ACCOUNTS: RoleAccount[] = [
  { key: 'ADMIN_MANAGER', username: 'skander',    password: PW, expectedRole: 'ADMIN_MANAGER', primaryTicketRoute: '/tickets/ticket/ticket-list',         hasDashboardMenu: true },
  { key: 'ADMIN_TECH',    username: 'admin_tech', password: PW, expectedRole: 'ADMIN_TECH',    primaryTicketRoute: '/tickets/ticket/ticket-list',         hasDashboardMenu: true },
  { key: 'MANAGER',       username: 'manager',    password: PW, expectedRole: 'MANAGER',       primaryTicketRoute: '/tickets/ticket/ticket-list',         hasDashboardMenu: false },
  // NOTE: expectedRole is the intentional DB misspelling "COORDIANTOR".
  { key: 'COORDINATOR',   username: 'coo',        password: PW, expectedRole: 'COORDIANTOR',   primaryTicketRoute: '/tickets/ticket/coordinator-di-list', hasDashboardMenu: false },
  { key: 'TECH',          username: 'tech',       password: PW, expectedRole: 'TECH',          primaryTicketRoute: '/tickets/ticket/tech-di-list',        hasDashboardMenu: false },
  { key: 'MAGASIN',       username: 'magasin',    password: PW, expectedRole: 'MAGASIN',       primaryTicketRoute: '/tickets/ticket/magasin-di-list',     hasDashboardMenu: false },
];

export function accountByKey(key: string): RoleAccount {
  const account = ROLE_ACCOUNTS.find((r) => r.key === key);
  if (!account) throw new Error(`Unknown role key: ${key}`);
  return account;
}
