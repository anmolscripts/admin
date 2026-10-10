'use strict';

/**
 * Spark Admin — One-Command Full Verification Suite
 * Executes syntax checks, schema validation, migration status, full test runner, and doctor checks.
 * Logs output to .artifacts/product-readiness/
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const ARTIFACTS_DIR = path.join(ROOT_DIR, '.artifacts', 'product-readiness');

if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function runCheck(name, cmd, args) {
    const startTime = new Date();
    console.log(`\n▶ [CHECK: ${name}] Running ${cmd} ${args.join(' ')}...`);

    const result = spawnSync(cmd, args, {
        cwd: ROOT_DIR,
        shell: true,
        encoding: 'utf-8',
        env: { ...process.env, NODE_ENV: 'test' }
    });

    const endTime = new Date();
    const durationMs = endTime - startTime;
    const passed = result.status === 0;

    const logFilename = `check_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.log`;
    const logFilePath = path.join(ARTIFACTS_DIR, logFilename);

    const logContent = [
        `CHECK: ${name}`,
        `COMMAND: ${cmd} ${args.join(' ')}`,
        `START: ${startTime.toISOString()}`,
        `END: ${endTime.toISOString()}`,
        `DURATION: ${durationMs}ms`,
        `EXIT_CODE: ${result.status}`,
        `STATUS: ${passed ? 'PASSED' : 'FAILED'}`,
        '='.repeat(60),
        result.stdout || '',
        result.stderr || ''
    ].join('\n');

    fs.writeFileSync(logFilePath, logContent, 'utf-8');

    if (passed) {
        console.log(`✔ [PASS: ${name}] (${durationMs}ms)`);
    } else {
        console.error(`✖ [FAIL: ${name}] (Exit code: ${result.status})`);
        if (result.stderr) console.error(result.stderr.trim());
    }

    return {
        name,
        passed,
        exitCode: result.status,
        durationMs,
        logFilePath
    };
}

async function main() {
    console.log('=' .repeat(64));
    console.log('   SPARK ADMIN — FULL VERIFICATION SUITE');
    console.log('=' .repeat(64));

    const checks = [
        // 1. Static Syntax Checks
        { name: 'Syntax_Server', cmd: 'node', args: ['--check', 'app/server.js'] },
        { name: 'Syntax_App', cmd: 'node', args: ['--check', 'app/app.js'] },
        { name: 'Syntax_Search_Service', cmd: 'node', args: ['--check', 'app/services/search.service.js'] },
        { name: 'Syntax_Profile_Service', cmd: 'node', args: ['--check', 'app/services/profile.service.js'] },
        { name: 'Syntax_Business_Profile', cmd: 'node', args: ['--check', 'app/services/businessProfile.service.js'] },
        { name: 'Syntax_Navigation_Service', cmd: 'node', args: ['--check', 'app/services/navigation.service.js'] },

        // 2. Prisma Schema Validation
        { name: 'Prisma_Schema_Validation', cmd: 'node', args: ['scripts/prisma-test.js', 'validate'] },

        // 3. Database Migration Status
        { name: 'Prisma_Migration_Status', cmd: 'node', args: ['scripts/prisma-test.js', 'migrate', 'status'] },

        // 4. Doctor System Health Probe
        { name: 'Doctor_Health_Check', cmd: 'node', args: ['scripts/doctor.js'] },

        // 5. Automated Regression Test Suite
        { name: 'Complete_Test_Suite', cmd: 'node', args: ['scripts/test-runner.js'] }
    ];

    const results = [];
    let overallPassed = true;

    for (const c of checks) {
        const res = runCheck(c.name, c.cmd, c.args);
        results.push(res);
        if (!res.passed) {
            overallPassed = false;
        }
    }

    console.log('\n' + '='.repeat(64));
    console.log('   VERIFICATION SUMMARY REPORT');
    console.log('='.repeat(64));

    results.forEach(r => {
        const mark = r.passed ? '✔' : '✖';
        console.log(` ${mark} ${r.name.padEnd(30)} [${r.passed ? 'PASSED' : 'FAILED'}] (${r.durationMs}ms)`);
    });

    console.log('-'.repeat(64));
    console.log(`Total Checks: ${results.length} | Passed: ${results.filter(r => r.passed).length} | Failed: ${results.filter(r => !r.passed).length}`);
    console.log(`Detailed logs saved to: ${ARTIFACTS_DIR}`);

    if (!overallPassed) {
        console.error('\n[VERIFICATION FAILED]: One or more required checks failed.\n');
        process.exit(1);
    } else {
        console.log('\n[VERIFICATION PASSED]: All product readiness quality gates satisfied.\n');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('[FATAL VERIFICATION ERROR]:', err);
    process.exit(1);
});
