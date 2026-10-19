/**
 * Read-only credential scan of newly created helper scripts.
 * Detects hardcoded passwords, inline connection strings, or plain-text secrets.
 * NEVER prints the actual credential value — prints only file + line number.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const SCRIPTS_TO_SCAN = [
  'scripts/verify_status_isolated.js',
  'scripts/verify_login_endpoint.js',
  'scripts/verify_protected_dbs.js',
  'scripts/readonly_db_comparison.js',
  'scripts/readonly_admin_inspect.js',
  'scripts/setup_dev_database.js',
  'scripts/verify_dev_readiness.js',
  'scripts/seed_dev_admin.js',
  'scripts/test_dev_server_flow.js',
  'scripts/audit_accounting_invariants.js',
  'scripts/preflight-db-check.js',
  'scripts/inspect-admin-readonly.js',
  'scripts/verify_backup_restoration.js',
  'scripts/postmigration_verify.js',
  'scripts/e2e_complete_project_integration.js',
  'scripts/e2e_financials_and_ops_acceptance.js',
  'scripts/e2e_full_business_reconciliation.js',
  'scripts/e2e_sales_lifecycle_acceptance.js',
];

// Patterns that suggest a hardcoded credential value
// We look for: password: 'xxx', password: "xxx", mysql://user:pass@, or anmol literal
const PATTERNS = [
  // password: 'literal' or password: "literal" (value must be >0 non-space chars)
  { name: 'hardcoded password literal', re: /password\s*:\s*(['"])[^\1\s]{1,64}\1/ },
  // mysql://user:SOMETHING@  (has a password segment)
  { name: 'inline connection string with credentials', re: /mysql:\/\/[^@\s]+:[^@\s]+@/ },
  // Fallback hardcoded value that matches the known local password
  // We check for the specific local dev credential as a literal string
  { name: 'known local dev credential literal', re: /(?<![A-Za-z_])(anmol)(?![A-Za-z_])/ },
];

let foundAny = false;

for (const rel of SCRIPTS_TO_SCAN) {
  if (!fs.existsSync(rel)) {
    console.log(`  skip (not found): ${rel}`);
    continue;
  }
  const content = fs.readFileSync(rel, 'utf8');
  const lines = content.split('\n');
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    for (const pat of PATTERNS) {
      if (pat.re.test(lines[i])) {
        hits.push({ lineNo: i + 1, pattern: pat.name });
      }
    }
  }

  if (hits.length) {
    foundAny = true;
    console.log(`\n  ⚠  CREDENTIAL PATTERN DETECTED: ${rel}`);
    hits.forEach(h => {
      console.log(`     Line ${h.lineNo}: pattern matched — "${h.pattern}" [value redacted]`);
    });
  } else {
    console.log(`  ✓  clean: ${rel}`);
  }
}

console.log('');
if (foundAny) {
  console.log('ACTION REQUIRED: remove hardcoded credentials from the files listed above.');
} else {
  console.log('No hardcoded credential literals found in scanned scripts.');
}
