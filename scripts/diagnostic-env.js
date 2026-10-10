// diagnostic-env.js – safe .env.test validation
// Run with: node scripts/diagnostic-env.js

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.resolve(process.cwd(), '.env.test');
console.log('🔍 Checking .env.test existence...');
if (!fs.existsSync(envPath)) {
  console.error('❌ .env.test file NOT found at', envPath);
  process.exit(1);
}
console.log('✅ .env.test exists.');

// Load variables without exposing values
const result = dotenv.config({ path: envPath });
if (result.error) {
  console.error('❌ Failed to parse .env.test:', result.error);
  process.exit(1);
}
console.log('✅ Parsed .env.test successfully.');

const env = process.env;
const required = ['DATABASE_NAME'];
let missing = required.filter(k => !env[k]);
if (missing.length) {
  console.error('❌ Missing required env vars:', missing.join(', '));
  process.exit(1);
}

const dbName = env.DATABASE_NAME;
console.log('🔎 DATABASE_NAME:', dbName);

if (dbName.toLowerCase() === 'admin') {
  console.error('❌ DATABASE_NAME is "admin" – prohibited for tests.');
  process.exit(1);
}

const url = env.DATABASE_URL;
if (!url) {
  console.warn('⚠️ DATABASE_URL not defined – will fall back to granular vars.');
} else {
  try {
    const parsed = new URL(url);
    const user = parsed.username ? decodeURIComponent(parsed.username) : null;
    const password = parsed.password ? decodeURIComponent(parsed.password) : null;
    const host = parsed.hostname;
    const port = parsed.port || '3306';
    const pathname = parsed.pathname.replace(/^\//, '');
    console.log('🗂 Parsed DATABASE_URL:');
    console.log('   • Host:', host);
    console.log('   • Port:', port);
    console.log('   • Database:', pathname);
    console.log('   • User present:', !!user);
    console.log('   • Password present:', !!password);
    if (pathname !== dbName) {
      console.error('❌ DATABASE_URL database does not match DATABASE_NAME.');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Invalid DATABASE_URL format:', e.message);
    process.exit(1);
  }
}

console.log('✅ Environment validation passed.');
process.exit(0);
