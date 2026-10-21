'use strict';

// Local production deployment. Secrets/state live under ignored data/, never in a release.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

// Windows machines may have an older system Node alongside the bundled runtime.
if (require.main === module && Number(process.versions.node.split('.')[0]) < 24) {
    const runtime = process.env.DEPLOY_NODE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe');
    if (!fs.existsSync(runtime)) {
        console.error('Deployment requires Node 24+. Install it or set DEPLOY_NODE to its executable.');
        process.exit(1);
    }
    const result = spawnSync(runtime, [__filename, ...process.argv.slice(2)], {
        stdio: 'inherit', env: { ...process.env, PATH: path.dirname(runtime) + path.delimiter + process.env.PATH }
    });
    process.exit(result.status ?? 1);
}

const DATA = path.join(ROOT, 'data');
const STATE = path.join(DATA, 'deployment-state.json');
const CONFIG = path.join(DATA, 'deploy-config.json');
const read = (file, fallback = {}) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const save = (file, value) => {
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function assertAdditive(sql, name) {
    if (/\/\*(?:!|M!)/i.test(sql)) throw new Error(`Migration ${name} contains executable comments; review it separately.`);
    const clean = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim();
    for (const statement of clean.split(';').map(s => s.trim()).filter(Boolean)) {
        // Referential actions on a newly created table do not rewrite existing rows.
        const checked = /^CREATE\s+TABLE\b/i.test(statement)
            ? statement.replace(/\bON\s+(?:DELETE|UPDATE)\s+(?:RESTRICT|CASCADE|NO\s+ACTION|SET\s+NULL)\b/gi, '') : statement;
        if (!/^(CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\b|ALTER\s+TABLE\s+`?\w+`?\s+ADD\s+)/i.test(statement) ||
            /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|REPLACE|RENAME|MODIFY|CHANGE)\b/i.test(checked)) {
            throw new Error(`Migration ${name} is not strictly additive. Review it separately; no migration was applied.`);
        }
    }
}

function run(args, cwd, env) {
    const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Command failed: ${args[0]}\n${result.stderr || result.stdout || result.error?.message}`);
    if (result.stdout) console.log(result.stdout.trim());
}

async function health(url, attempts = 40) {
    for (let i = 0; i < attempts; i++) {
        try {
            const result = await fetch(url + '/health', { signal: AbortSignal.timeout(3000), headers: { 'ngrok-skip-browser-warning': 'true' } });
            const body = await result.json();
            if (result.ok && body.status === 'ok' && body.database === 'connected') return body;
        } catch (_) { /* Retry during startup. */ }
        await sleep(500);
    }
    throw new Error(`Health check failed: ${url}/health`);
}

function launch(executable, args, cwd, env, prefix) {
    const out = fs.openSync(path.join(DATA, prefix + '.stdout.log'), 'a');
    const err = fs.openSync(path.join(DATA, prefix + '.stderr.log'), 'a');
    try {
        const child = spawn(executable, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', out, err] });
        child.on('error', error => console.error(`Background startup failed: ${error.code}`));
        child.unref();
        if (!child.pid) throw new Error(`Could not start ${prefix}`);
        return child.pid;
    } finally { fs.closeSync(out); fs.closeSync(err); }
}

function tunnelUrl(payload) {
    return (payload?.tunnels || []).find(tunnel => {
        try {
            const address=new URL(String(tunnel.config?.addr).includes('://')?tunnel.config.addr:'http://'+tunnel.config?.addr);
            return ['localhost','127.0.0.1'].includes(address.hostname)&&address.port==='3000'&&new URL(tunnel.public_url).protocol==='https:';
        } catch (_) { return false; }
    })?.public_url || null;
}
async function findTunnel() {
    try {
        const response=await fetch('http://127.0.0.1:4040/api/tunnels',{signal:AbortSignal.timeout(2000)});
        return response.ok?tunnelUrl(await response.json()):null;
    } catch (_) { return null; }
}

async function stop(pid, expected) {
    if (!pid) return;
    try { process.kill(pid, 0); } catch (_) { return; }
    // Do not terminate a reused PID belonging to a different application.
    const command = process.platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true })
        : spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
    const normalize = value => value.replace(/\\/g, '/').toLowerCase();
    if (command.status !== 0 || !normalize(command.stdout || '').includes(normalize(expected))) {
        throw new Error(`PID ${pid} does not match the managed process. Refusing to stop it.`);
    }
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 40; i++) {
        try { process.kill(pid, 0); } catch (_) { return; }
        await sleep(250);
    }
    throw new Error(`Process ${pid} did not stop; deployment stopped.`);
}

function releaseEnvironment(release, base, previous) {
    const dotenv = require('dotenv');
    const previousEnv = previous && fs.existsSync(path.join(previous, '.env'))
        ? dotenv.parse(fs.readFileSync(path.join(previous, '.env'))) : {};
    const secret = previousEnv.SESSION_SECRET || base.SESSION_SECRET;
    const env = { ...base, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3000',
        SESSION_STORE: 'database', TRUST_PROXY: 'true',
        SESSION_SECRET: secret && secret.length >= 32 ? secret : require('crypto').randomBytes(48).toString('hex'),
        ATTACHMENT_STORAGE_DIR: path.join(ROOT, 'data/attachments').replace(/\\/g, '/') };
    fs.writeFileSync(path.join(release, '.env'), Object.entries(env).map(([k,v]) => `${k}=${JSON.stringify(String(v))}`).join('\n'), { mode: 0o600 });
    for (const relative of ['assets/uploads', 'data']) {
        const target = path.join(ROOT, relative);
        const link = path.join(release, relative);
        fs.mkdirSync(target, { recursive: true });
        fs.mkdirSync(path.dirname(link), { recursive: true });
        // Packaging retains a harmless avatars/.gitkeep directory; preserve it first.
        if (fs.existsSync(link)) fs.renameSync(link, link + '.packaged');
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return { ...process.env, ...env };
}

function parseArguments(argv) {
    const { values } = require('node:util').parseArgs({ args: argv, options: {
        status: { type: 'boolean' }, 'skip-backup': { type: 'boolean' }
    } });
    if (values.status && values['skip-backup']) throw new Error('--status cannot be combined with --skip-backup.');
    return { status: !!values.status, skipBackup: !!values['skip-backup'] };
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    fs.mkdirSync(DATA, { recursive: true });
    const config = read(CONFIG);
    let state = read(STATE);
    if (options.status) {
        if (!state.url) throw new Error('No managed deployment found. Run npm run build first.');
        await health('http://127.0.0.1:3000', 1);
        await health(state.url, 1);
        console.log(`Production healthy: ${state.url}\nRelease: ${state.release}\nDeployed: ${state.deployedAt}`);
        return;
    }
    const lock = path.join(DATA, 'deployment.lock');
    const fd = fs.openSync(lock, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    let db, stopped = false, newPid;
    const previous = { ...state };
    try {
        const dotenv = require('dotenv');
        const base = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env')));
        const env = { ...process.env, ...base };
        const upgrade = require('./db-upgrade');
        const preflight = require('./lib/migration-preflight');
        const target = upgrade.parseDatabaseTarget(env.DATABASE_URL, env.DATABASE_NAME);
        preflight.verifyMigrationSource(ROOT);
        if (!(config.ngrokPath && fs.existsSync(config.ngrokPath))) throw new Error('Set ngrokPath in data/deploy-config.json.');
        if (!(process.env.NGROK_AUTHTOKEN || config.ngrokAuthtoken || config.ngrokConfig)) throw new Error('Configure NGROK_AUTHTOKEN or ngrokAuthtoken/ngrokConfig in data/deploy-config.json.');
        const migrations = preflight.readMigrations(path.join(ROOT, 'prisma/migrations'));
        await preflight.prepareDatabase({ target, env, migrations, createDatabase: false });
        db = await require('mariadb').createConnection(preflight.connectionOptions(env, target));
        const applied = new Set((await db.query('SELECT migration_name FROM _prisma_migrations')).map(r => r.migration_name));
        for (const m of migrations.filter(m => !applied.has(m.name))) assertAdditive(fs.readFileSync(path.join(ROOT, 'prisma/migrations', m.name, 'migration.sql'), 'utf8'), m.name);
        const deploymentId = 'deploy-' + new Date().toISOString().replace(/[:.]/g, '-');
        const backup = options.skipBackup ? null : path.join(DATA, 'backups', deploymentId);
        if (state.release) {
            const releaseRoot = path.join(ROOT, 'dist/builds') + path.sep;
            if (!path.resolve(state.release).startsWith(releaseRoot)) throw new Error('Current release is outside dist/builds.');
        }
        if (backup) {
            fs.mkdirSync(backup, { recursive: true });
            if (state.release) {
                fs.cpSync(state.release, path.join(backup, 'release'), { recursive: true,
                    filter: source => !fs.lstatSync(source).isSymbolicLink() && !source.split(path.sep).includes('node_modules') });
            }
            const url = new URL(env.DATABASE_URL);
            const dumpPath = config.mysqldumpPath || (process.platform === 'win32' ? 'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysqldump.exe' : 'mysqldump');
            const dump = path.join(backup, target.database + '.sql');
            const result = spawnSync(dumpPath, ['--host='+target.host, '--port='+target.port, '--user='+decodeURIComponent(url.username), '--single-transaction', '--routines', '--events', '--triggers', '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF', '--result-file='+dump, target.database], {
                env: { ...env, MYSQL_PWD: decodeURIComponent(url.password) }, encoding: 'utf8'
            });
            if (result.status !== 0 || !fs.existsSync(dump) || !fs.readFileSync(dump, 'utf8').includes('-- Dump completed on')) throw new Error('Complete SQL backup could not be verified; deployment stopped.');
            save(path.join(backup, 'previous-state.json'), previous);
            console.log(`Previous release and database backed up: ${backup}`);
        } else console.log('Backup skipped (--skip-backup). Schema and existing-data checks remain enabled.');
        const evidence = backup || path.join(DATA, 'deployments', deploymentId);
        fs.mkdirSync(evidence, { recursive: true });
        const release = require('./build').build();
        const productionEnv = releaseEnvironment(release, base, previous.release);
        run([process.env.npm_execpath, 'ci', '--omit=dev', '--no-audit', '--no-fund'], release, productionEnv);
        await stop(state.appPid, state.appIdentity || path.join(state.release || '', 'app/server.js'));
        stopped = true;
        const before = {};
        for (const row of await db.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"')) {
            const table = Object.values(row)[0];
            before[table] = String((await db.query('SELECT COUNT(*) AS n FROM '+db.escapeId(table)))[0].n);
        }
        save(path.join(evidence, 'row-counts-before.json'), before);
        run([path.join(release, 'scripts/db-upgrade.js'), '--confirm-db='+target.database, options.skipBackup ? '--skip-backup' : '--backup-confirmed'], release, productionEnv);
        const after = {};
        for (const table of Object.keys(before)) {
            after[table] = String((await db.query('SELECT COUNT(*) AS n FROM '+db.escapeId(table)))[0].n);
            if (table !== '_prisma_migrations' && before[table] !== after[table]) throw new Error(`Row count changed in ${table}. Review migration and deployment evidence; no automatic database restore attempted.`);
        }
        save(path.join(evidence, 'row-counts-after.json'), after);
        const server = path.join(release, 'app/server.js');
        newPid = launch(process.execPath, [server], release, productionEnv, 'production');
        state = { ...state, release, appPid: newPid, appIdentity: server, backup, deployedAt: new Date().toISOString() };
        save(STATE, state);
        await health('http://127.0.0.1:3000');
        state.url=await findTunnel();
        if(state.url)console.log('Existing ngrok tunnel retained for the updated production server.');
        else {
        await stop(state.ngrokPid, config.ngrokPath);
        const args = ['http', 'http://127.0.0.1:3000', '--log=stdout', '--log-format=json'];
        if (config.ngrokConfig) args.push('--config', config.ngrokConfig);
        state.ngrokPid = launch(config.ngrokPath, args, ROOT, { ...process.env, NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN || config.ngrokAuthtoken || '' }, 'ngrok');
        state.url = null;
        save(STATE, state);
        for (let i = 0; i < 40; i++) {
            try {
                state.url = await findTunnel();
                if (state.url) break;
            } catch (_) {}
            await sleep(500);
        }
        if (!state.url) throw new Error('Ngrok did not start. Inspect data/ngrok.stderr.log.');
        }
        await health(state.url);
        save(STATE, state);
        fs.writeFileSync(path.join(ROOT, 'dist/current-release.txt'), release);
        fs.writeFileSync(path.join(DATA, 'production-live-url.txt'), state.url);
        console.log(`\nProduction deployment verified. Database: ${target.database}; existing row counts preserved.\nLIVE: ${state.url}\nKeep this computer running. Check later with npm run live:status.`);
    } catch (error) {
        // Restore only the application process. Never roll back or reset the database automatically.
        if (stopped && previous.release) {
            try {
                if (newPid) await stop(newPid, path.join(state.release, 'app/server.js'));
                const env = { ...process.env, ...require('dotenv').parse(fs.readFileSync(path.join(previous.release, '.env'))) };
                previous.appIdentity = path.join(previous.release, 'app/server.js');
                previous.appPid = launch(process.execPath, [previous.appIdentity], previous.release, env, 'production');
                previous.ngrokPid = state.ngrokPid;
                save(STATE, previous);
                await health('http://127.0.0.1:3000');
                console.error('Previous application restarted. Database was not restored or reset.');
            } catch (_) { console.error('Automatic application restart failed; inspect data/production.stderr.log.'); }
        }
        throw error;
    } finally {
        if (db) await db.end();
        fs.closeSync(fd);
        fs.unlinkSync(lock);
    }
}

if (require.main === module) main().catch(error => {
    const env = require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true }).parsed || {};
    console.error('[DEPLOYMENT FAILED] ' + require('./db-upgrade').sanitizeOutput(error.message, env.DATABASE_URL));
    process.exitCode = 1;
});
module.exports = { assertAdditive, health, tunnelUrl, main, parseArguments };
