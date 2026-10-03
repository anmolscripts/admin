'use strict';

/**
 * Cross-platform console logger for Spark Admin installer and diagnostics.
 * Uses standard ANSI escapes supported across Windows Terminal, Linux, and macOS.
 */

const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;

function c(color, text) {
    if (!supportsColor) return text;
    return `${colors[color] || ''}${text}${colors.reset}`;
}

const logger = {
    section(current, total, title) {
        console.log('\n' + c('bold', c('cyan', `[${current}/${total}] ${title}`)));
        console.log(c('dim', '─'.repeat(60)));
    },

    pass(message) {
        console.log(`  ${c('bold', c('green', '✔ PASS'))}  ${message}`);
    },

    fail(message) {
        console.log(`  ${c('bold', c('red', '✖ FAIL'))}  ${message}`);
    },

    warn(message) {
        console.log(`  ${c('bold', c('yellow', '⚠ WARN'))}  ${message}`);
    },

    info(message) {
        console.log(`  ${c('dim', '• INFO')}  ${message}`);
    },

    step(message) {
        console.log(`  ${c('blue', '→')} ${message}`);
    },

    box(title, lines = []) {
        const width = 64;
        console.log('\n' + c('cyan', '╔' + '═'.repeat(width - 2) + '╗'));
        console.log(c('cyan', '║') + ' ' + c('bold', title.padEnd(width - 4)) + ' ' + c('cyan', '║'));
        console.log(c('cyan', '╠' + '═'.repeat(width - 2) + '╣'));
        for (const line of lines) {
            const raw = line.replace(/\x1b\[[0-9;]*m/g, '');
            const pad = Math.max(0, width - 4 - raw.length);
            console.log(c('cyan', '║') + ' ' + line + ' '.repeat(pad) + ' ' + c('cyan', '║'));
        }
        console.log(c('cyan', '╚' + '═'.repeat(width - 2) + '╝') + '\n');
    },

    formatError(error) {
        if (!error) return 'Unknown error occurred.';
        if (typeof error === 'string') return error;

        // Clean user-friendly message without dumping stack traces for operational errors
        let msg = error.message || String(error);
        // Scrub passwords/secrets from error strings
        msg = msg.replace(/:([^:@/]+)@/g, ':****@');
        return msg;
    }
};

module.exports = logger;
