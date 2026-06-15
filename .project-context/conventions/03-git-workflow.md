# Git Workflow

**Purpose:** Document branching, commit conventions, remotes, and CI — based on the actual git history of both repos.

---

## Repository layout
- The workspace root (`fixtronix erp/`) is **not** a git repo. Each app is its **own** repository:

| App | Remote | Default branch |
|-----|--------|----------------|
| `fix-back/` | `github.com/SkanderLassoued09/fix-back.git` | `master` |
| `fix-front/` | `github.com/SkanderLassoued09/fix-front.git` | `master` |

> Because they're separate repos, a change spanning both (e.g. a new GraphQL field) needs **two commits in two repos** kept in sync.

## Branches (observed)
- Both repos currently sit on **`add-playwright-testing`** (work in progress to add Playwright e2e).
- Other branches seen: `tech-module-upgrade`, `Fix-back-end` (back); `fix-tech-module-improve` (front).
- Workflow is informal feature branches merged into `master`. No release branches/tags observed.

## Commit style (observed)
Short, lowercase, **informal** messages — no Conventional Commits. Examples:
```
pushed with error in rep modal
cleanup: reorganize gitignore and remove unwanted tracked files
Dashboard live + alert stuck DI
fix performance
deps
.
```
There is no enforced format. If you want to raise the bar, prefer a short imperative summary (e.g. `fix: coordinator list null check`), but match the existing low-ceremony style for small changes.

## CI
- **None in-repo.** No `.github/workflows`, no CircleCI/GitLab config. The README badges in `fix-back/README.md` are the default NestJS starter badges, not this project's pipelines.
- Tests, lint, and builds are run manually (see [02-testing.md](02-testing.md) and [operations/02-running.md](../operations/02-running.md)).

## .gitignore highlights
- Both ignore `node_modules`, `dist`/`build`, `*.log`, `logs/`, coverage, caches. The backend `.gitignore` was recently reorganized into sections.
- ⚠️ `.env` should be ignored and **must never be committed** — but note secrets are currently **hardcoded in source** (JWT secret, Discord webhook), which defeats `.gitignore`. See [decisions/01-known-issues.md](../decisions/01-known-issues.md).
- Build artifacts that *are* present in the working tree (e.g. `fix-back/backend.log`, `fix-front/frontend.log`, `dist/`) are git-ignored, not tracked.

---

## Related files
- [02-testing.md](02-testing.md), [operations/02-running.md](../operations/02-running.md)
