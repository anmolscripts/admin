# Local production deployment

Run `npm run build` from the project root. It backs up the previous release and configured database, validates and packages the application, installs production dependencies, stops the managed app, applies committed forward migrations, verifies existing table row counts, starts the production release, refreshes ngrok, and prints the verified HTTPS link.

The development checkout keeps its own `.env`. Releases have production settings and share the project's existing attachment and upload storage. You can develop with `npm run dev` using a different port (for example `PORT=3001` in your development `.env`); the public production app uses port 3000. Use a separate development database if development should not change live records.

- `npm run live:status`: verify local and public database health and display the deployed release/link.
- `npm run build:only`: create a verified package without deployment or database access. Requires Node 24 on PATH.

The deployment command selects the bundled Node 24 runtime when the Windows system Node is older. On other machines install Node 24+, or set `DEPLOY_NODE` to its executable.

Local configuration is in ignored `data/deploy-config.json`: `ngrokPath`, optional `ngrokAuthtoken` (or set `NGROK_AUTHTOKEN`), optional `ngrokConfig`, and optional `mysqldumpPath`. Never commit tokens. MySQL 8 mysqldump is the default backup utility. Backups and row-count evidence are retained under `data/backups/deploy-*`; prior release dependencies remain under `dist/builds`. Backups include release sources/configuration and SQL; shared uploads remain in their original storage.

Only committed migrations with matching existing history may deploy. The automated path accepts only CREATE TABLE/INDEX and ALTER TABLE ADD statements. Other SQL requires separate review; it never invokes reset, seed, db push, or automatic database restoration. If startup fails, it attempts to restart the previous app against the current schema. A failed or partially applied database migration needs manual review.

Concurrent deployments are blocked by `data/deployment.lock`. After an interrupted command, verify that the PID recorded there has exited before manually removing that lock. State and logs are under `data/`. Only recorded processes whose command lines match are stopped. Builds may briefly interrupt service during migration and restart. A free ngrok account may reuse the same domain when refreshed. The link stays available while this computer, production process, and ngrok run; this command does not install a boot service.
