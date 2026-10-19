const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const auditDir = path.resolve(ROOT_DIR, '.artifacts', 'audit_rc4');
if (fs.existsSync(auditDir)) fs.rmSync(auditDir, { recursive: true, force: true });
fs.mkdirSync(auditDir, { recursive: true });

const rc4Zip = path.resolve(ROOT_DIR, 'dist', 'candidates', 'spark-admin-release-candidate-rc4.zip');

const res = spawnSync('powershell', [
  '-Command',
  `Expand-Archive -Path '${rc4Zip}' -DestinationPath '${auditDir}' -Force`
]);

if (res.status !== 0) {
  console.error('Extraction failed:', res.stderr ? res.stderr.toString() : 'unknown');
  process.exit(1);
}

console.log('Successfully extracted RC4 to', auditDir);

function getAllFiles(dir, base = dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of list) {
    const full = path.join(dir, item.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (item.isDirectory()) {
      results = results.concat(getAllFiles(full, base));
    } else {
      results.push(rel);
    }
  }
  return results;
}

const extractedFiles = getAllFiles(auditDir);
console.log('Extracted file count:', extractedFiles.length);

const forbiddenPatterns = [
  /^\.git(\/|$)/,
  /^node_modules(\/|$)/,
  /^dist(\/|$)/,
  /\.log$/,
  /^\.artifacts(\/|$)/,
  /assets\/uploads\/avatars\/(?!(\.gitkeep$))/,
  /\.sql\.dump$/,
  /\.swp$/,
  /^\.env/
];

const forbiddenFound = extractedFiles.filter(f => forbiddenPatterns.some(p => p.test(f)));
console.log('Forbidden files found in RC4:', forbiddenFound.length > 0 ? forbiddenFound : 'NONE (0)');

let differences = [];
for (const rel of extractedFiles) {
  const extractedPath = path.join(auditDir, rel);
  const sourcePath = path.resolve(ROOT_DIR, rel);
  if (!fs.existsSync(sourcePath)) {
    differences.push({ file: rel, type: 'MISSING_IN_SOURCE' });
    continue;
  }
  const hExtracted = crypto.createHash('sha256').update(fs.readFileSync(extractedPath)).digest('hex');
  const hSource = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  if (hExtracted !== hSource) {
    differences.push({ file: rel, type: 'CONTENT_DIFFERENCE' });
  }
}

console.log('Differences between RC4 and working tree:', differences.length);
if (differences.length > 0) {
  differences.forEach(d => console.log(` - [${d.type}] ${d.file}`));
}

// Also check if any working tree files that SHOULD be packaged were not packaged
const { buildFileList } = require('./package-candidate');
const expectedList = buildFileList().map(f => f.replace(/\\/g, '/'));
console.log('Expected file list count per buildFileList():', expectedList.length);

const missingInRc4 = expectedList.filter(f => !extractedFiles.includes(f));
console.log('Files expected by buildFileList() missing in RC4:', missingInRc4.length > 0 ? missingInRc4 : 'NONE (0)');

const extraInRc4 = extractedFiles.filter(f => !expectedList.includes(f));
console.log('Files in RC4 not in buildFileList():', extraInRc4.length > 0 ? extraInRc4 : 'NONE (0)');
