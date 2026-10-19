'use strict';

const path = require('node:path');
const readline = require('node:readline');
const { collectConfiguration, askQuestion } = require('./env-manager');

function parseOptions(argv) {
    const allowed = new Set(['mode', 'non-interactive', 'confirm-db', 'reset-confirmed',
        'db-host', 'db-port', 'db-user', 'db-password', 'db-name',
        'admin-email', 'admin-password', 'overwrite-env', 'port']);
    const flags = new Set(['non-interactive', 'reset-confirmed', 'overwrite-env']);
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
        if (!match || !allowed.has(match[1])) throw new Error('Unsupported fresh-install option. No database was changed.');
        const key = match[1];
        if (flags.has(key)) {
            if (match[2] !== undefined) throw new Error('Boolean installation flags do not accept values.');
            options[key] = true;
        } else {
            const value = match[2] === undefined ? argv[++i] : match[2];
            if (!value || value.startsWith('--')) throw new Error('Missing installation option value.');
            options[key] = value;
        }
    }
    if (options.mode && options.mode !== 'production') throw new Error('This entrypoint installs production only.');
    return options;
}

async function confirmReset(target) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await askQuestion(rl,
            'This permanently deletes ALL data in ' + target.database + ' on ' + target.host + ':' + target.port +
            '. Type RESET ' + target.database + ' to continue');
        return answer === 'RESET ' + target.database;
    } finally { rl.close(); }
}

async function installProduction(argv = process.argv.slice(2), dependencies = {}) {
    const root = path.resolve(__dirname, '../..');
    const log = dependencies.log || console.log;
    let env;
    let prisma;
    try {
        const options = parseOptions(argv);
        (dependencies.installDependencies || require('./install-dependencies').installDependencies)();
        const interactive = dependencies.isInteractive === undefined
            ? Boolean(process.stdin.isTTY && !options['non-interactive']) : dependencies.isInteractive;
        const result = await (dependencies.collectConfiguration || collectConfiguration)({
            mode: 'production', isInteractive: interactive, overwriteEnv: Boolean(options['overwrite-env']),
            cliArgs: options, rootPath: root, deferWrite: true
        });
        env = result.config;
        const { parseDatabaseTarget, sanitizeOutput } = require('../db-upgrade');
        const { connectionOptions, readMigrations } = require('./migration-preflight');
        const target = parseDatabaseTarget(env.DATABASE_URL, env.DATABASE_NAME);
        const connectionConfig = connectionOptions(env, target);
        if (!result.adminCredentials.email || !result.adminCredentials.email.includes('@') ||
            !result.adminCredentials.password || result.adminCredentials.password.length < 8) {
            throw new Error('A valid initial administrator email and password (at least 8 characters) are required.');
        }
        readMigrations(path.join(root, 'prisma/migrations'));
        // Fresh reset intentionally accepts local migration SQL: there is no
        // existing history to upgrade. The migration-only command still enforces provenance.
        if (options['confirm-db'] && options['confirm-db'] !== target.database) throw new Error('Reset confirmation does not match the configured database.');
        const confirmed = interactive
            ? await (dependencies.confirmReset || confirmReset)(target)
            : options['confirm-db'] === target.database && options['reset-confirmed'] === true;
        if (!confirmed) throw new Error('Reset cancelled. Non-interactive fresh installs require --confirm-db=<exact-name> --reset-confirmed.');
        const cli = dependencies.runPrisma || require('./prisma-cli').runPrismaCommand;
        const run = args => {
            const result = cli(args, env);
            if (!result.ok) throw new Error(sanitizeOutput(result.error || result.stderr || 'Prisma command failed.', env.DATABASE_URL));
        };
        run(['validate']);
        run(['generate']);
        const ensure = dependencies.ensureDatabase || require('./db-manager').ensureDatabaseExists;
        await ensure({ ...connectionConfig });
        const connect = dependencies.createConnection || (config => require('mariadb').createConnection(config));
        let connection;
        try {
            connection = await connect(connectionConfig);
            const [identity] = await connection.query('SELECT DATABASE() AS database_name');
            if (identity?.database_name !== target.database) throw new Error('Connected database does not match the confirmed target.');
        } finally { if (connection) await connection.end(); }
        result.persist();
        log('Resetting confirmed database and applying local migrations. All existing records will be removed.');
        // Do not fabricate Prisma AI-consent environment variables.
        run(['migrate', 'reset', '--force']);
        if (!dependencies.seed) {
            Object.assign(process.env, env);
            prisma = require('../../app/config/prisma');
            await require('../../prisma/seed/production').seedProduction(prisma, {
                seedDemoData: false, adminEmail: result.adminCredentials.email,
                adminPassword: result.adminCredentials.password
            });
            const verification = await require('./verifier').verifyDatabaseState(prisma, 'production');
            if (!verification.ok) throw new Error('Fresh production verification failed; inspect the bootstrap before retrying.');
        } else await dependencies.seed({ seedDemoData: false, ...result.adminCredentials });
        log('Fresh production installation complete: administrator and system records only; no sample business data.');
    } catch (error) {
        // Never echo an arbitrary driver or configuration error containing credentials.
        const message = env
            ? require('../db-upgrade').sanitizeOutput(error.message, env.DATABASE_URL)
            : 'Installation options, dependencies or configuration are invalid; no database operation was started.';
        log('[INSTALL ABORTED] ' + message);
        throw new Error(message);
    } finally { if (prisma) await prisma.$disconnect(); }
}

module.exports = { installProduction, parseOptions, confirmReset };
