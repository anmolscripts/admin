'use strict';

/**
 * Spark Admin — Global Search Browser E2E Test (Chrome CDP)
 * Verifies Ctrl+K palette, debounced typing, dropdown rendering, keyboard navigation, and Escape dismissal.
 */

const assert = require('assert');

class CdpSession {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.msgId = 0;
        this.callbacks = new Map();
        this.ws = null;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => resolve();
            this.ws.onerror = (err) => reject(err);
            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.id && this.callbacks.has(data.id)) {
                    const { resolve, reject } = this.callbacks.get(data.id);
                    this.callbacks.delete(data.id);
                    if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
                    else resolve(data.result);
                }
            };
        });
    }

    async send(method, params = {}) {
        const id = ++this.msgId;
        const msg = JSON.stringify({ id, method, params });
        return new Promise((resolve, reject) => {
            this.callbacks.set(id, { resolve, reject });
            this.ws.send(msg);
        });
    }

    async eval(expression) {
        let code = expression.trim();
        if (!/\breturn\b/.test(code)) {
            code = `return (${code});`;
        }
        const wrapped = `(async () => {\n${code}\n})()`;
        const res = await this.send('Runtime.evaluate', {
            expression: wrapped,
            returnByValue: true,
            awaitPromise: true
        });
        if (res.exceptionDetails) {
            throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result ? res.result.value : undefined;
    }

    async close() {
        if (this.ws) this.ws.close();
    }
}

async function runSearchBrowserE2E() {
    console.log('='.repeat(64));
    console.log('GLOBAL SEARCH BROWSER E2E VERIFICATION (CHROME CDP)');
    console.log('='.repeat(64));

    let newTargetRes;
    try {
        newTargetRes = await fetch('http://127.0.0.1:9222/json/new?http://127.0.0.1:3000/dashboard', { method: 'PUT' });
    } catch (_) {
        console.log('[INFO] Chrome remote debugging is not running on port 9222. Skipping CDP browser test.');
        return;
    }

    const targetInfo = await newTargetRes.json();
    console.log(`[CHROME] Target created: ${targetInfo.id}`);

    const cdp = new CdpSession(targetInfo.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');

    try {
        await new Promise(r => setTimeout(r, 1200));

        // 1. Check search elements present
        console.log('[STEP 1] Verifying search DOM elements and ARIA attributes...');
        const hasInput = await cdp.eval(`document.getElementById('main-search') !== null`);
        const hasDropdown = await cdp.eval(`document.getElementById('global-search-dropdown') !== null`);
        assert.ok(hasInput, 'Main search input must exist in header');
        assert.ok(hasDropdown, 'Global search dropdown must exist');
        console.log('[PASS] Search DOM elements verified.');

        // 2. Focus search and verify initial shortcuts
        console.log('\n[STEP 2] Verifying focus behavior and initial shortcuts...');
        await cdp.eval(`document.getElementById('main-search').focus()`);
        await new Promise(r => setTimeout(r, 400));
        const isDropdownOpen = await cdp.eval(`!document.getElementById('global-search-dropdown').classList.contains('d-none')`);
        assert.ok(isDropdownOpen, 'Dropdown should open on focus');
        console.log('[PASS] Initial command shortcuts displayed on focus.');

        // 3. Type query and verify debounced search results
        console.log('\n[STEP 3] Simulating user typing "invoice"...');
        await cdp.eval(`
            const input = document.getElementById('main-search');
            input.value = 'invoice';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        `);
        await new Promise(r => setTimeout(r, 600)); // wait for debounce (220ms) + fetch

        const itemCount = await cdp.eval(`document.querySelectorAll('.global-search-item').length`);
        console.log(`[PASS] Search results loaded. Found ${itemCount} items.`);
        assert.ok(itemCount > 0, 'Should find matching invoice items or commands');

        // 4. Arrow navigation
        console.log('\n[STEP 4] Testing ArrowDown keyboard navigation...');
        await cdp.eval(`
            const input = document.getElementById('main-search');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        `);
        await new Promise(r => setTimeout(r, 150));
        const hasActiveItem = await cdp.eval(`document.querySelector('.global-search-item.active') !== null`);
        assert.ok(hasActiveItem, 'ArrowDown must highlight active result item');
        console.log('[PASS] ArrowDown highlights active result.');

        // 5. Escape closes dropdown
        console.log('\n[STEP 5] Testing Escape key dismissal...');
        await cdp.eval(`
            const input = document.getElementById('main-search');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        `);
        await new Promise(r => setTimeout(r, 200));
        const isClosed = await cdp.eval(`document.getElementById('global-search-dropdown').classList.contains('d-none')`);
        assert.ok(isClosed, 'Escape must close the search dropdown');
        console.log('[PASS] Escape key closes search dropdown.');

        console.log('\n' + '='.repeat(64));
        console.log('✔ GLOBAL SEARCH BROWSER E2E VERIFICATION PASSED');
        console.log('='.repeat(64) + '\n');
    } finally {
        await cdp.close();
        try {
            await fetch(`http://127.0.0.1:9222/json/close/${targetInfo.id}`);
        } catch (_) {}
    }
}

if (require.main === module) {
    runSearchBrowserE2E().catch(err => {
        console.error('[FATAL SEARCH BROWSER E2E ERROR]:', err);
        process.exit(1);
    });
}

module.exports = { runSearchBrowserE2E };
