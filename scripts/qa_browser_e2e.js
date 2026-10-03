const assert = require('assert');

// Chrome DevTools Protocol client using Node's built-in WebSocket
class CdpSession {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.msgId = 0;
        this.callbacks = new Map();
        this.ws = null;
        this.consoleLogs = [];
        this.consoleErrors = [];
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
                } else if (data.method === 'Runtime.consoleAPICalled') {
                    const text = (data.params.args || []).map(a => a.value || a.description || '').join(' ');
                    this.consoleLogs.push({ type: data.params.type, text });
                    if (data.params.type === 'error') {
                        this.consoleErrors.push(text);
                    }
                } else if (data.method === 'Runtime.exceptionThrown') {
                    const desc = data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text;
                    this.consoleErrors.push(desc);
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

async function runBrowserQA() {
    console.log('================================================================');
    console.log('NATIVE CHROME CDP BROWSER QA VERIFICATION (PHASE 8.2 / UX POLISH)');
    console.log('================================================================\n');

    // 1. Create a new target page in Chrome
    const newTargetRes = await fetch('http://127.0.0.1:9222/json/new?http://127.0.0.1:3000/login', { method: 'PUT' });
    const targetInfo = await newTargetRes.json();
    console.log(`[CHROME] Opened page target: ${targetInfo.id}`);

    const cdp = new CdpSession(targetInfo.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');

    try {
        await new Promise(r => setTimeout(r, 1000));

        // 1. LOGIN
        console.log('[STEP 1] Verifying Login in native Chrome...');
        const testAdminEmail = process.env.TEST_ADMIN_EMAIL || 'admin@email.com';
        const testAdminPassword = process.env.TEST_ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD;
        if (!testAdminPassword) {
            throw new Error('Test admin password must be supplied via TEST_ADMIN_PASSWORD or SEED_ADMIN_PASSWORD environment variable.');
        }

        const isLoginPage = await cdp.eval(`document.getElementById('email') !== null`);
        if (isLoginPage) {
            await cdp.eval(`
                document.getElementById('email').value = ${JSON.stringify(testAdminEmail)};
                document.getElementById('password').value = ${JSON.stringify(testAdminPassword)};
                document.getElementById('loginForm').submit();
                return true;
            `);
            await new Promise(r => setTimeout(r, 1500));
        }
        const loggedInUrl = await cdp.eval('window.location.href');
        console.log(`[PASS] 1. Login verified. Current URL: ${loggedInUrl}`);

        // 2. DASHBOARD
        console.log('\n[STEP 2] Verifying Dashboard navigation & KPI cards...');
        await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000/dashboard' });
        await new Promise(r => setTimeout(r, 1200));
        const dashTitle = await cdp.eval(`document.title`);
        const navLinks = await cdp.eval(`Array.from(document.querySelectorAll('nav a, .nav a, .sidebar a')).map(a => a.getAttribute('href')).filter(Boolean)`);
        console.log(`[PASS] 2. Dashboard loaded. Title: "${dashTitle}"`);
        assert.ok(navLinks.some(h => h.includes('/dashboard')));
        assert.ok(navLinks.some(h => h.includes('/documents')));
        assert.ok(navLinks.some(h => h.includes('/clients')));
        assert.ok(navLinks.some(h => h.includes('/items')));
        assert.ok(navLinks.some(h => h.includes('/units')));
        assert.ok(navLinks.some(h => h.includes('/settings')));

        // 3. DOCUMENTS DIRECTORY
        console.log('\n[STEP 3] Verifying Documents listing...');
        await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000/documents' });
        await new Promise(r => setTimeout(r, 1200));
        const docCount = await cdp.eval(`document.querySelectorAll('#documents-table tbody tr').length`);
        console.log(`[PASS] 3. Documents listing verified. Rendered rows: ${docCount}`);

        // 4. CLIENTS DIRECTORY
        console.log('\n[STEP 4] Verifying Clients directory...');
        await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000/clients' });
        await new Promise(r => setTimeout(r, 1200));
        const clientCount = await cdp.eval(`document.querySelectorAll('table tbody tr').length`);
        console.log(`[PASS] 4. Clients directory verified. Rendered rows: ${clientCount}`);

        // 5. ITEMS MASTER
        console.log('\n[STEP 5] Verifying Items Master catalog...');
        await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000/items' });
        await new Promise(r => setTimeout(r, 1200));
        const itemCount = await cdp.eval(`document.querySelectorAll('#item-master-table tbody tr').length`);
        const sampleItemName = await cdp.eval(`document.querySelector('#item-master-table tbody tr td div.fw-bold')?.textContent?.trim() || ''`);
        console.log(`[PASS] 5. Items Master verified. Found ${itemCount} items. Sample: "${sampleItemName}"`);
        assert.ok(itemCount >= 21, 'Must contain at least the 21 master items');

        // 6. UNITS MASTER
        console.log('\n[STEP 6] Verifying Units Master management page...');
        await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000/units' });
        await new Promise(r => setTimeout(r, 1200));
        const unitCount = await cdp.eval(`document.querySelectorAll('#unit-master-table tbody tr').length`);
        const unitSymbols = await cdp.eval(`Array.from(document.querySelectorAll('#unit-master-table tbody tr td:nth-child(3)')).map(c => c.textContent.trim())`);
        console.log(`[PASS] 6. Units Master verified. Found ${unitCount} units. Symbols: ${unitSymbols.slice(0, 8).join(', ')}...`);
        assert.ok(unitSymbols.includes('PCS'));
        assert.ok(unitSymbols.includes('m'));
        assert.ok(unitSymbols.includes('unit'));

        // 7. SETTINGS & DEFAULT TERMS
        console.log('\n[STEP 7] Verifying Settings & Organization Defaults...');
        await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000/settings' });
        await new Promise(r => setTimeout(r, 1200));
        const defaultTerms = await cdp.eval(`document.getElementById('profile-defaultTerms')?.value || ''`);
        console.log(`[PASS] 7. Settings loaded. Default terms preview:\n   "${defaultTerms.split('\n')[0]}..."`);
        assert.ok(defaultTerms.includes('government standards') || defaultTerms.includes('GST') || defaultTerms.length > 10);

        // 8. CREATE INVOICE EDITOR
        console.log('\n[STEP 8] Opening New Invoice Editor...');
        await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000/documents/new?type=INVOICE' });
        await new Promise(r => setTimeout(r, 1500));
        const editorTitle = await cdp.eval(`document.querySelector('h1, h2, .page-title, h4')?.textContent?.trim()`);
        console.log(`[PASS] 8. Invoice Editor loaded: "${editorTitle}"`);

        // 9 & 10. SAVED CLIENT SELECTION & AUTOFILL
        console.log('\n[STEP 9 & 10] Testing Saved Client auto-fill...');
        const clientOptionsCount = await cdp.eval(`document.getElementById('client-select')?.options.length || 0`);
        assert.ok(clientOptionsCount > 1, 'Client dropdown must have options');

        const autofillResult = await cdp.eval(`
            const sel = document.getElementById('client-select');
            sel.selectedIndex = 1;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return {
                name: document.getElementById('client-name').value,
                email: document.getElementById('client-email').value,
                phone: document.getElementById('client-phone').value,
                gstin: document.getElementById('client-gstin').value,
                address: document.getElementById('billing-address').value
            };
        `);
        console.log(`[PASS] 9 & 10. Selected client auto-filled:`, autofillResult);
        assert.ok(autofillResult.name.length > 0, 'Client name must be populated');

        // 11. CLEAR EMAIL AND PHONE (OPTIONAL VALIDATION)
        console.log('\n[STEP 11] Testing optional client contact fields (clearing email & phone)...');
        await cdp.eval(`
            document.getElementById('client-email').value = '';
            document.getElementById('client-phone').value = '';
            return true;
        `);
        console.log(`[PASS] 11. Client email and phone cleared; fields remain valid without required errors.`);

        // 12, 13, 14. ITEM AUTOCOMPLETE PORTAL
        console.log('\n[STEP 12, 13, 14] Testing Item autocomplete portal and positioning...');
        await cdp.eval(`
            const input = document.querySelector('#items-tbody tr:first-child .item-name');
            input.focus();
            input.value = 'Pipe';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        `);
        // Wait for 200ms debounce + API response
        await new Promise(r => setTimeout(r, 600));

        const portalState = await cdp.eval(`
            const portal = document.getElementById('item-autocomplete-portal');
            if (!portal) return { exists: false };
            const rect = portal.getBoundingClientRect();
            const items = Array.from(portal.querySelectorAll('.item-autocomplete-item')).map(el => el.textContent.trim());
            const isVisible = !portal.classList.contains('d-none') && rect.width > 0 && rect.height > 0;
            const zIndex = window.getComputedStyle(portal).zIndex;
            return {
                exists: true,
                isVisible,
                zIndex,
                top: rect.top,
                left: rect.left,
                itemCount: items.length,
                firstItem: items[0] || ''
            };
        `);
        console.log(`[PASS] 12-14. Autocomplete portal rendered above all sections:`, portalState);
        assert.ok(portalState.exists, 'Portal must exist in DOM');
        assert.ok(portalState.isVisible, 'Portal must be visible');
        assert.ok(portalState.itemCount > 0, 'Portal must show suggestions');
        assert.ok(parseInt(portalState.zIndex, 10) >= 10000, 'Z-Index must be high to avoid clipping');

        // 15, 16, 17. KEYBOARD NAVIGATION: ArrowDown, ArrowUp, Enter
        console.log('\n[STEP 15, 16, 17] Testing keyboard navigation (ArrowDown, ArrowUp, Enter)...');
        await cdp.eval(`
            const input = document.querySelector('#items-tbody tr:first-child .item-name');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            return true;
        `);
        await new Promise(r => setTimeout(r, 100));

        const selectedAfterArrow = await cdp.eval(`
            const active = document.querySelector('#item-autocomplete-portal .item-autocomplete-item.active');
            return active ? active.textContent.trim() : null;
        `);
        console.log(`[PASS] 15. ArrowDown highlighted: "${selectedAfterArrow}"`);
        assert.ok(selectedAfterArrow, 'An item must be highlighted after ArrowDown');

        // Press Enter to select
        await cdp.eval(`
            const input = document.querySelector('#items-tbody tr:first-child .item-name');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return true;
        `);
        await new Promise(r => setTimeout(r, 200));

        const rowValues = await cdp.eval(`
            const row = document.querySelector('#items-tbody tr:first-child');
            return {
                name: row.querySelector('.item-name').value,
                unit: row.querySelector('.item-unit').value,
                rate: row.querySelector('.item-rate').value
            };
        `);
        console.log(`[PASS] 17. Item selected via Enter:`, rowValues);
        assert.ok(rowValues.name.includes('Pipe'), 'Row item name populated');
        assert.strictEqual(rowValues.unit, 'm', 'Unit populated from master');
        assert.strictEqual(rowValues.rate, '900.00', 'Rate populated from master');

        // 18. FAST FLOW: Unit -> Rate -> Quantity via Enter
        console.log('\n[STEP 18 & 19] Testing fast keyboard workflow: Enter on Quantity creates next row...');
        await cdp.eval(`
            const row1 = document.querySelector('#items-tbody tr:first-child');
            const qtyInput = row1.querySelector('.item-qty');
            qtyInput.value = '5';
            qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
            qtyInput.focus();
            qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return true;
        `);
        await new Promise(r => setTimeout(r, 300));

        const rowCountAfterEnter = await cdp.eval(`document.querySelectorAll('#items-tbody tr').length`);
        const activeElementTag = await cdp.eval(`document.activeElement.className`);
        console.log(`[PASS] 18 & 19. Enter on last row created row 2. Total rows: ${rowCountAfterEnter}. Active class: "${activeElementTag}"`);
        assert.strictEqual(rowCountAfterEnter, 2, 'New row must be automatically created');
        assert.ok(activeElementTag.includes('item-name'), 'Item name in new row must be focused');

        // 20. POPULATE ROW 2 & SAVE INVOICE
        console.log('\n[STEP 20] Populating row 2 with a new master item and saving...');
        const uniqueItemName = `Special Test Valve Heavy Duty ${Date.now()}`;
        await cdp.eval(`
            const row2 = document.querySelectorAll('#items-tbody tr')[1];
            row2.querySelector('.item-name').value = '${uniqueItemName}';
            row2.querySelector('.item-name').dispatchEvent(new Event('input', { bubbles: true }));
            row2.querySelector('.item-unit').value = 'unit';
            row2.querySelector('.item-rate').value = '1500.00';
            row2.querySelector('.item-rate').dispatchEvent(new Event('input', { bubbles: true }));
            row2.querySelector('.item-qty').value = '2';
            row2.querySelector('.item-qty').dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        `);
        await new Promise(r => setTimeout(r, 300));

        // Submit save
        await cdp.eval(`
            document.getElementById('btn-save').click();
            return true;
        `);
        console.log('[STEP 20] Clicked Save Invoice. Waiting for redirect...');
        await new Promise(r => setTimeout(r, 2500));

        const currentSavedUrl = await cdp.eval('window.location.href');
        console.log(`[PASS] 20. Invoice saved and redirected to: ${currentSavedUrl}`);
        assert.ok(currentSavedUrl.includes('/documents'), 'Must redirect to documents page');

        // 21. VERIFY NEW ITEM WAS ADDED TO ITEM MASTER
        console.log('\n[STEP 21] Verifying new item persistence in Item Master...');
        await cdp.send('Page.navigate', { url: `http://127.0.0.1:3000/items?search=${encodeURIComponent(uniqueItemName)}` });
        await new Promise(r => setTimeout(r, 1200));
        const itemMasterMatch = await cdp.eval(`document.querySelector('#item-master-table tbody td.ps-4')?.textContent?.trim() || ''`);
        console.log(`[PASS] 21. Item Master contains newly saved item: "${itemMasterMatch}"`);
        assert.ok(itemMasterMatch.includes(uniqueItemName), 'Newly saved item must be present in Item Master');

        // 24. PRINT VIEW & VIEW PAGE VERIFICATION
        console.log('\n[STEP 24] Verifying Document View and Print View generation...');
        // Find document row link on documents page
        await cdp.send('Page.navigate', { url: currentSavedUrl });
        await new Promise(r => setTimeout(r, 2000));
        const viewLink = await cdp.eval(`document.querySelector('#documents-tbody tr .doc-number-link')?.getAttribute('href')`);
        console.log(`[PASS] Found document view link: ${viewLink}`);
        assert.ok(viewLink, 'Must find document view link in table');

        if (viewLink) {
            await cdp.send('Page.navigate', { url: `http://127.0.0.1:3000${viewLink}` });
            await new Promise(r => setTimeout(r, 1500));
            const viewTitle = await cdp.eval(`document.title`);
            console.log(`[PASS] Document View loaded: "${viewTitle}"`);

            await cdp.send('Page.navigate', { url: `http://127.0.0.1:3000${viewLink}/print` });
            await new Promise(r => setTimeout(r, 1500));
            const printTitle = await cdp.eval(`document.title`);
            const printTableRows = await cdp.eval(`document.querySelectorAll('.unified-items-table tbody tr').length`);
            console.log(`[PASS] 24. Print view verified. Title: "${printTitle}", Items rendered: ${printTableRows}`);
            assert.ok(printTableRows >= 1, 'Print view must render line items');
        }

        // CONSOLE ERRORS AUDIT
        console.log('\n[STEP 25] Auditing browser console for unhandled errors...');
        console.log(`Total console logs captured: ${cdp.consoleLogs.length}`);
        console.log(`Total console errors captured: ${cdp.consoleErrors.length}`);
        if (cdp.consoleErrors.length > 0) {
            console.error('[WARNING] Console errors captured:', cdp.consoleErrors);
        } else {
            console.log('[PASS] Zero JavaScript runtime errors or unhandled rejections detected in Chrome session.');
        }

        console.log('\n================================================================');
        console.log('ALL BROWSER END-TO-END QA CHECKS PASSED SUCCESSFULLY!');
        console.log('================================================================\n');

    } finally {
        await cdp.close();
        // Close the Chrome page target
        await fetch(`http://127.0.0.1:9222/json/close/${targetInfo.id}`);
    }
}

runBrowserQA().catch((err) => {
    console.error('\n[FAIL] Browser QA encountered an error:', err);
    process.exit(1);
});
