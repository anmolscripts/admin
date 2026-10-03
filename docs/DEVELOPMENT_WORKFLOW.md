# Engineering Development & Git Workflow

## 1. Local Environment Setup & Diagnostics

To bootstrap a clean local development environment reliably:

```bash
# Automated zero-friction development setup
npm run dev:install

# Verify environment health and database connectivity
npm run doctor
```

See [docs/INSTALLATION.md](file:///c:/Users/User/Documents/project/admin/docs/INSTALLATION.md) and [docs/DEVELOPER_HANDBOOK.md](file:///c:/Users/User/Documents/project/admin/docs/DEVELOPER_HANDBOOK.md) for full setup guides.

---

## 2. Branching Model

Spark Admin follows a trunk-based branch workflow with protected `main`:

```
main (Production Baseline)
  │
  ├── feature/client-export-csv
  ├── fix/overdue-date-calculation
  ├── docs/api-examples
  └── chore/upgrade-linter
```

### Branch Naming Conventions
- `feature/<name>`: New business functionality or user workflows.
- `fix/<name>`: Defect resolutions, bug fixes, or edge-case handling.
- `refactor/<name>`: Code restructuring without changing external behavior.
- `docs/<name>`: Documentation, ADRs, or README updates.
- `chore/<name>`: Tooling, dependency maintenance, or CI scripts.

---

## 3. Core Development Rules

1. **Never Commit Directly to `main`:** All functional changes must be submitted via feature branches and code review.
2. **One Logical Change per Commit:** Avoid grouping unrelated edits into massive monolithic commits. Write clear, imperative commit messages (e.g., `feat: implement client export`, `fix: handle leap year due dates`).
3. **Database Changes Require Formal Migrations:** Never edit a database schema manually or run `db push`. Use `npx prisma migrate dev --name <migration_name>` and commit the resulting migration folder.
4. **Never Modify Past Migration Files:** Once a migration has been applied and committed, it is immutable. Schema adjustments must be introduced as new forward migrations.
5. **Never Commit Secrets:** `.env` must remain untracked. Avoid staging API keys, production tokens, or test credentials.
6. **Zero Regression Policy:** Every pull request must pass the automated test suite (`npm test`). Never comment out, bypass, or delete assertions to make a build pass.
7. **No Unrelated Formatting / Line-Ending Noise:** Honor `.editorconfig` and `.gitattributes`. Avoid reformatting whole files unrelated to your task.
8. **Frozen Core Invariance:** Do not alter the 20 frozen core architecture contracts documented in [docs/CORE_CONTRACTS.md](file:///c:/Users/User/Documents/project/admin/docs/CORE_CONTRACTS.md) without an approved Architecture Decision Record (ADR).

---

## 4. Pull Request Checklist

Before submitting a Pull Request for review, verify every item:

### Environment & Pre-Flight
- [ ] System health and diagnostic checks pass: `npm run doctor`.

### Code Quality & Design
- [ ] Code follows [docs/CODING_STANDARDS.md](file:///c:/Users/User/Documents/project/admin/docs/CODING_STANDARDS.md).
- [ ] No business logic resides in routes or controllers; services encapsulate domain rules.
- [ ] Concurrency version tokens are respected on document modifications.
- [ ] No `console.log` statements left behind in production service paths.

### Database & Migrations
- [ ] Schema changes formatted (`npx prisma format`).
- [ ] Migrations applied cleanly (`npx prisma migrate status`).
- [ ] Prisma Client regenerated (`npx prisma generate`).

### Automated Testing
- [ ] Unit or integration tests added for newly introduced features or bug fixes.
- [ ] Entire test suite passes without hanging: `npm test`.
- [ ] All tests terminate cleanly without resorting to `process.exit()`.

### Security & Sanitization
- [ ] Input parameters validated; SQL queries strictly parameterized via Prisma.
- [ ] CSRF tokens enforced on any new `POST`/`PUT`/`DELETE` endpoints.
- [ ] No hardcoded passwords, tokens, or credentials staged.
- [ ] `git diff --check` passes with zero whitespace or line-ending warnings.

### Documentation
- [ ] Applicable documentation updated in `docs/` (`API.md`, `USER_MANUAL.md`, etc.).
- [ ] If changing a core architectural pattern, an ADR is included in `docs/ADR/`.
