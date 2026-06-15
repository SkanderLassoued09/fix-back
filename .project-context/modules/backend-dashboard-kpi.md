# Module: Backend — Dashboard KPIs & Analytics

**Purpose:** Document the KPI aggregation module that powers the dashboard.

---

## Responsibility

Compute global and per-technician performance metrics over configurable date windows by aggregating the `Di`, `Stat`, `Profile`, and `LogsDi` collections. Lives in [`fix-back/src/dashboard-kpi/`](../../fix-back/src/dashboard-kpi/).

## Key files

| File | Role |
|------|------|
| [`dashboard-kpi.resolver.ts`](../../fix-back/src/dashboard-kpi/dashboard-kpi.resolver.ts) | GraphQL queries |
| [`dashboard-kpi.service.ts`](../../fix-back/src/dashboard-kpi/dashboard-kpi.service.ts) | Main KPI aggregations |
| [`tech-analytics.service.ts`](../../fix-back/src/dashboard-kpi/tech-analytics.service.ts) | Per-technician leaderboard pipeline |
| [`entities/dashboard-kpi.entity.ts`](../../fix-back/src/dashboard-kpi/entities/dashboard-kpi.entity.ts) | Output GraphQL types |

## GraphQL queries

| Query | Returns | Notes |
|-------|---------|-------|
| `dashboardKpi(startDate?, endDate?)` | composite `DashboardKpi` | overview: atelier, délais, volume, finance |
| `dashboardTrend(startDate?, endDate?, granularity)` | `TrendPoint[]` | DAY/WEEK/MONTH buckets |
| `dashboardCategories(...)` | `CategorySlice[]` | DI count per category |
| `dashboardFinanceTrend(...)` | `FinanceTrendPoint[]` | revenue/margin over time |
| `dashboardTechLeaderboard(limit=20)` | `TechLeaderRow[]` | per-tech metrics |

## KPI groups (output types)

- **AtelierKpi** — closure rate (`tauxClotures`), in-progress rate/count.
- **DelaisKpi** — average TAT in days, % stagnant, average status age.
- **VolumeKpi** — received / closed / in-progress / returns counts.
- **FinanceKpi** — invoicing rate (`tauxFacturation`), revenue (CA), gross margin, hourly cost, receivables.
- **SatisfactionKpi** — placeholder (future ratings).
- **TechLeaderRow** — per technician: DI count, **FTR%** (First Time Right = `ignoreCount === 0`), return rate, average TAT, irreparable %.

## Tech analytics pipeline

`tech-analytics.service.ts` runs a Mongo aggregation joining `Stat → Di → Profile`, computing per technician: total DIs, closed count, FTR, return rate, irreparable rate, and average TAT (`createdAt` → finished `updatedAt`). Resolves display names server-side.

> The `Di` schema's compound indexes (`{status,createdAt}`, `{status,updatedAt}`, `{di_category_id,createdAt}`) exist specifically to make these aggregations efficient — see [di.entity.ts](../../fix-back/src/di/entities/di.entity.ts).

## Frontend counterpart

[`fix-front/src/app/demo/components/dashboard/`](../../fix-front/src/app/demo/components/dashboard/) — `dashboard.component.ts` renders these via `dashboard-data/dashboard.service.ts`, which (unlike most frontend services) uses **parameterized** `$startDate/$endDate` variables. A `period-filter/` component selects the date range. See [frontend-shell-auth-dashboard.md](frontend-shell-auth-dashboard.md).

---

## Related files
- [backend-di-domain.md](backend-di-domain.md) — Stat/DI data these read
- [frontend-shell-auth-dashboard.md](frontend-shell-auth-dashboard.md)
