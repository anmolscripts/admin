'use strict';

/**
 * Spark Admin — One-Command Full Verification Suite
 * Executes syntax checks, schema validation, migration status, full test runner, and doctor checks.
 * Logs output to .artifacts/product-readiness/
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const ARTIFACTS_DIR = path.join(ROOT_DIR, '.artifacts', 'product-readiness');

if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

async function runCheck(name, cmd, args, envOverrides = {}) {
    const startTime = new Date();
    console.log(`\n▶ [CHECK: ${name}] Running ${cmd} ${args.join(' ')}...`);

    const logFilename = `check_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.log`;
    const logFilePath = path.join(ARTIFACTS_DIR, logFilename);
    const log = fs.createWriteStream(logFilePath);
    log.write(`CHECK: ${name}\nCOMMAND: ${cmd} ${args.join(' ')}\nSTART: ${startTime.toISOString()}\n`);
    const result = await new Promise(resolve => {
        const child = spawn(cmd === 'node' ? process.execPath : cmd, args, {
            cwd: ROOT_DIR,
            shell: false,
            windowsHide: true,
            env: { ...process.env, NODE_ENV: 'test', ...envOverrides }
        });
        const progress = setInterval(() => console.log(`  ${name} is still running; output: ${logFilePath}`), 30000);
        child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
        child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
        child.on('error', error => { log.write(`${error.message}\n`); });
        child.on('close', code => { clearInterval(progress); resolve({ status: code }); });
    });

    const endTime = new Date();
    const durationMs = endTime - startTime;
    const passed = result.status === 0;

    const logContent = [
        `END: ${endTime.toISOString()}`,
        `DURATION: ${durationMs}ms`,
        `EXIT_CODE: ${result.status}`,
        `STATUS: ${passed ? 'PASSED' : 'FAILED'}`,
        '='.repeat(60)
    ].join('\n');

    await new Promise(resolve => log.end(`\n${logContent}\n`, resolve));

    if (passed) {
        console.log(`✔ [PASS: ${name}] (${durationMs}ms)`);
    } else {
        console.error(`✖ [FAIL: ${name}] (Exit code: ${result.status})`);
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

    // Refuse protected/misconfigured targets before applying test migrations.
    require('./lib/test-database-config').readTestDatabaseConfig(ROOT_DIR);
    console.log('   SPARK ADMIN — FULL VERIFICATION SUITE');
    console.log('=' .repeat(64));

    const checks = [
        // 1. Static Syntax Checks
        { name: 'Syntax_Server', cmd: 'node', args: ['--check', 'app/server.js'] },
        { name: 'Syntax_App', cmd: 'node', args: ['--check', 'app/app.js'] },
        { name: 'Syntax_Search_Service', cmd: 'node', args: ['--check', 'app/services/search.service.js'] },
        { name: 'Syntax_Profile_Service', cmd: 'node', args: ['--check', 'app/services/profile.service.js'] },
        { name: 'Syntax_Business_Profile', cmd: 'node', args: ['--check', 'app/services/businessProfile.service.js'] },
        { name: 'Syntax_Business_Service', cmd: 'node', args: ['--check', 'app/services/business.service.js'] },
        { name: 'Syntax_Numbering_Service', cmd: 'node', args: ['--check', 'app/services/numbering.service.js'] },
        { name: 'Syntax_Reporting_Workbench', cmd: 'node', args: ['--check', 'app/services/reportingWorkbench.service.js'] },
        { name: 'Syntax_Schema_Readiness', cmd: 'node', args: ['--check', 'app/config/schemaReadiness.js'] },
        { name: 'Syntax_Navigation_Service', cmd: 'node', args: ['--check', 'app/services/navigation.service.js'] },
        { name: 'Syntax_Payroll_Service', cmd: 'node', args: ['--check', 'app/services/payroll.service.js'] },

        // 2. Prisma Schema Validation
        { name: 'Prisma_Schema_Validation', cmd: 'node', args: ['scripts/prisma-test.js', 'validate'] },
        { name: 'Prisma_Client_Generation', cmd: 'node', args: ['scripts/prisma-test.js', 'generate'] },

        // 3. Database Migration Status
        { name: 'Prisma_Test_Migrations', cmd: 'node', args: ['scripts/prisma-test.js', 'migrate', 'deploy'] },
        { name: 'Prisma_Migration_Status', cmd: 'node', args: ['scripts/prisma-test.js', 'migrate', 'status'] },

        // 4. Doctor System Health Probe
        { name: 'Doctor_Health_Check', cmd: 'node', args: ['scripts/doctor.js'] },
        { name: 'Doctor_Configured_Environment', cmd: 'node', args: ['scripts/doctor.js'],
            env: { NODE_ENV: require('./lib/env-file').parseEnvFile(path.join(ROOT_DIR, '.env')).NODE_ENV || 'development' } },

        // 5. Automated Regression Test Suite
        { name: 'Complete_Test_Suite', cmd: 'node', args: ['scripts/test-runner.js'] },

        // 6. Genuine Forward Upgrade Proof (Migration 16 -> 17 -> 18 -> 19)
        { name: 'Migration_16_Upgrade_Proof', cmd: 'node', args: ['scripts/test-upgrade-from-m16.js'] }
    ];

    const npmCli = process.env.npm_execpath;
    if (!npmCli || !fs.existsSync(npmCli)) throw new Error('Run verification through npm run verify:all so the release build can locate npm.');
    checks.push({ name: 'Release_Build', cmd: 'node', args: [npmCli, 'run', 'build:only'] });
    for (const file of ['scripts/setup.js', 'scripts/lib/env-manager.js', 'scripts/lib/install-dependencies.js',
        'scripts/lib/test-database-config.js', 'scripts/prisma-test.js', 'scripts/verify-all.js', 'scripts/doctor.js',
        'app/services/accounting/report.service.js', 'app/services/stockMovement.service.js']) {
        checks.unshift({ name: `Syntax_${file}`, cmd: 'node', args: ['--check', file] });
    }

    const results = [];
    let overallPassed = true;

    for (const c of checks) {
        const res = await runCheck(c.name, c.cmd, c.args, c.env);
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
