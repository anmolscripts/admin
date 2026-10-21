# Verification after changes

The user requires working commands after every change. Do not mark a task complete
based only on an edit or a narrow test.

- Run `npm run verify:all` after code, dependency, configuration, or script changes.
  It must cover syntax, Prisma validation and migration status, doctor, the full
  test suite, upgrade verification, and `npm run build:only`.
- For installer or command changes, also exercise the affected command paths,
  including interactive answers, cancellation, and non-interactive execution.
  Test destructive install/reset/upgrade paths with mocks or isolated disposable
  databases. Never reset the user's configured database for verification.
- After dependency changes, verify a clean `npm ci --engine-strict` and ensure
  `package.json` and `package-lock.json` agree on the supported local Node version.
- Smoke-test affected server startup commands and confirm an HTTP health response;
  shut down only processes started for that verification.
- `npm run build` deploys the live application. Use `npm run build:only` to verify
  the release build unless deployment is part of the user's request.
- Fix failures caused by the change and rerun the affected checks. Report command
  results and any unresolved failures or untested paths explicitly. Do not claim
  that all commands work when a check failed, timed out, or was skipped.
