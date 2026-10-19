'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — SAFE TARGETED SESSION INVALIDATION
 * ==============================================================================
 * Connects to the exposed CDP page target, extracts CSRF token, executes
 * POST /logout to destroy the session server-side, and confirms revocation.
 * ==============================================================================
 */

const BASE_URL = 'http://127.0.0.1:3001';
const CDP_BASE = 'http://127.0.0.1:9222';

async function main() {
    const listRes = await fetch(`${CDP_BASE}/json/list`);
    const targets = await listRes.json();
    const appTarget = targets.find(t => t.url && t.url.startsWith(BASE_URL) && t.type === 'page');

    if (!appTarget) {
        console.log('[SESSION CLEANUP] No active application page target found.');
        return;
    }

    console.log(`[SESSION CLEANUP] Found active page target: ${appTarget.id} (${appTarget.url})`);

    const ws = new WebSocket(appTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });

    const sendCdp = (method, params = {}) => new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1000000);
        const onMsg = (event) => {
            const data = JSON.parse(event.data);
            if (data.id === id) {
                ws.removeEventListener('message', onMsg);
                if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
                else resolve(data.result);
            }
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
    });

    // 1. Extract cookies before logout to verify revocation after
    const cookiesBefore = await sendCdp('Network.getCookies', { urls: [BASE_URL] });
    const sessionCookieBefore = (cookiesBefore.cookies || []).find(c => c.name === 'spark.sid');

    if (!sessionCookieBefore) {
        console.log('[SESSION CLEANUP] No active spark.sid cookie found on target.');
        ws.close();
        return;
    }

    console.log('[SESSION CLEANUP] Active session cookie detected (identity masked for security).');

    // 2. Execute supported logout via UI form / fetch inside page context
    const evalResult = await sendCdp('Runtime.evaluate', {
        expression: `(async () => {
            const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
                         document.querySelector('input[name="_csrf"]')?.value || '';
            const res = await fetch('/logout', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: '_csrf=' + encodeURIComponent(csrf)
            });
            return { ok: res.ok, status: res.status, url: res.url };
        })()`,
        returnByValue: true,
        awaitPromise: true
    });

    console.log('[SESSION CLEANUP] Logout response:', JSON.stringify(evalResult.result ? evalResult.result.value : evalResult));

    // 3. Clear browser cookies via CDP
    await sendCdp('Network.clearBrowserCookies');

    // 4. Verify that session is completely dead by testing authenticated endpoint with the old session
    const testOldSessionRes = await fetch(`${BASE_URL}/api/business-profile`, {
        headers: {
            'Cookie': `spark.sid=${sessionCookieBefore.value}`
        }
    });

    console.log(`[SESSION CLEANUP] Verification: Request with old session returned HTTP ${testOldSessionRes.status}`);
    const isRevoked = testOldSessionRes.status === 401 || testOldSessionRes.status === 403 || testOldSessionRes.redirected;
    console.log(`[SESSION CLEANUP] Confirmed Session Revocation: ${isRevoked ? 'REVOKED (PASS)' : 'FAILED'}`);

    ws.close();
}

main().catch(err => {
    console.error('[SESSION CLEANUP ERROR]:', err);
    process.exit(1);
});
