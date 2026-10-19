'use strict';
async function main(argv = process.argv.slice(2), dependencies = {}) {
    (dependencies.installDependencies || require('./lib/install-dependencies').installDependencies)();
    if (argv.length === 0 && process.stdin.isTTY && !dependencies.upgrade) {
        const readline = require('node:readline');
        const path = require('node:path');
        const { parseEnvFile } = require('./lib/env-file');
        const { askQuestion } = require('./lib/env-manager');
        const config = { ...parseEnvFile(path.resolve(__dirname, '../.env')), ...process.env };
        const target = require('./db-upgrade').parseDatabaseTarget(config.DATABASE_URL, config.DATABASE_NAME);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
            const name = await askQuestion(rl, 'Upgrade preserves data. Confirm database ' + target.database + ' on ' + target.host + ':' + target.port + ' by typing its exact name');
            const backup = await askQuestion(rl, 'Have you verified a backup? Type yes');
            if (name !== target.database || backup !== 'yes') throw new Error('Upgrade cancelled; target and backup acknowledgement are required.');
            argv = ['--confirm-db=' + target.database, '--backup-confirmed'];
        } finally { rl.close(); }
    }
    return (dependencies.upgrade || require('./db-upgrade').main)(argv);
}
if (require.main === module) main().catch(error => {
    try {
        const sanitize = require('./db-upgrade').sanitizeOutput;
        console.error(`[MIGRATION ABORTED] ${sanitize(error.message, process.env.DATABASE_URL)}`);
    } catch (_) { console.error('[MIGRATION ABORTED] Dependencies could not be installed; no database operation started.'); }
    process.exitCode = 1;
});
module.exports = { main };
