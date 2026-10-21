// scripts/prisma-test.js
// Utility to execute Prisma CLI commands using the test environment safely.
// Usage: node scripts/prisma-test.js <prisma subcommand> [args...]
// Example: node scripts/prisma-test.js migrate status

const path = require('node:path');
const dotenv = require('dotenv');
const { resolveTestDatabaseConfig } = require('./lib/test-database-config');
const { runPrismaCommand } = require('./lib/prisma-cli');

// Load test env variables and override any existing ones, unless DATABASE_URL is explicitly set.
dotenv.config({ path: path.resolve(process.cwd(), '.env.test'), override: !process.env.DATABASE_URL });

// Ensure we are targeting a non‑admin database.
if (!process.env.DATABASE_NAME) {
  console.error('ERROR: DATABASE_NAME is not set in .env.test');
  process.exit(1);
}
const protectedDbs = ['admin', 'spark_admin', 'spark_admin_prod', 'spark_admin_test', 'spark_admin_prod_test'];
if (protectedDbs.includes(process.env.DATABASE_NAME.toLowerCase())) {
  console.error(`ERROR: Test configuration must not target protected database "${process.env.DATABASE_NAME}".`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/prisma-test.js <prisma command> [options]');
  process.exit(1);
}

// Use the local CLI and validate URL/name agreement before any database command.
resolveTestDatabaseConfig(process.env);
const result = runPrismaCommand(args, { NODE_ENV: 'test', PRISMA_DISABLE_ENV_VAR_LOADING: 'true' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (!result.ok && !result.stderr) console.error(result.error);
process.exit(result.ok ? 0 : 1);
