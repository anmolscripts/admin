// scripts/prisma-test.js
// Utility to execute Prisma CLI commands using the test environment safely.
// Usage: node scripts/prisma-test.js <prisma subcommand> [args...]
// Example: node scripts/prisma-test.js migrate status

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const dotenv = require('dotenv');

// Load test env variables and override any existing ones, unless DATABASE_URL is explicitly set.
dotenv.config({ path: path.resolve(process.cwd(), '.env.test'), override: !process.env.DATABASE_URL });

// Ensure we are targeting a non‑admin database.
if (!process.env.DATABASE_NAME) {
  console.error('ERROR: DATABASE_NAME is not set in .env.test');
  process.exit(1);
}
if (process.env.DATABASE_NAME.toLowerCase() === 'admin') {
  console.error('ERROR: Test configuration must not target the production "admin" database.');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/prisma-test.js <prisma command> [options]');
  process.exit(1);
}

// Build the full Prisma CLI command.
const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// Explicitly point to the custom Prisma config file
const prismaArgs = ['prisma', '--config', './prisma7.config.ts', ...args];

const result = spawnSync('npx', prismaArgs, {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test', PRISMA_DISABLE_ENV_VAR_LOADING: 'true' },
  shell: true,
});

if (result.error) {
  console.error('Failed to execute Prisma CLI:', result.error);
  process.exit(1);
}
process.exit(result.status !== null ? result.status : 1);
