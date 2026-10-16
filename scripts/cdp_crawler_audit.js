const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = path.join(__dirname, '../.cdp_profile_crawler');
const ARTIFACTS_DIR = 'C:\\Users\\User\\.gemini\\antigravity-ide\\brain\\efee2647-5f99-4f7a-8130-661aacf061e1';
const PORT = 9225;

async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.method === 'Page.javascriptDialogOpening') {
          this.send('Page.handleJavaScriptDialog', { accept: true });
        }
        if (msg.id && this.callbacks.has(msg.id)) {
          const cb = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          if (msg.error) cb.reject(msg.error);
          else cb.resolve(msg.result);
        }
      };
    });
  }

  async send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() {
    if (this.ws) this.ws.close();
  }
}

const PAGES_TO_AUDIT = [
  { name: 'dashboard', url: 'http://localhost:3000/dashboard' },
  { name: 'documents', url: 'http://localhost:3000/documents' },
  { name: 'clients', url: 'http://localhost:3000/clients' },
  { name: 'items', url: 'http://localhost:3000/items' },
  { name: 'units', url: 'http://localhost:3000/units' },
  { name: 'settings', url: 'http://localhost:3000/settings' },
  { name: 'profile', url: 'http://localhost:3000/profile' },
  { name: 'team', url: 'http://localhost:3000/team' },
  { name: 'expenses', url: 'http://localhost:3000/financials/expenses' },
  { name: 'reports', url: 'http://localhost:3000/reports' }
];

async function run() {
  console.log('Spawning Chrome for full project audit...');
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check'
  ]);

  try {
    let version = null;
    for (let i = 0; i < 30; i++) {
      try {
        version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
        break;
      } catch (e) {
        await sleep(300);
      }
    }
    if (!version) throw new Error('Chrome failed to start');

    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const pageTarget = list.find(t => t.type === 'page');
    const client = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await client.connect();

    await client.send('Page.enable');
    await client.send('DOM.enable');

    // Set desktop
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    // 1. Log in
    console.log('Logging in via /login...');
    await client.send('Page.navigate', { url: 'http://localhost:3000/login' });
    await sleep(1500);

    await client.send('Runtime.evaluate', {
      expression: `
        (() => {
          document.getElementById('email').value = 'admin@email.com';
          document.getElementById('password').value = 'super-secret-password-2026';
          document.getElementById('loginForm').submit();
        })()
      `
    });
    await sleep(2500);

    const auditResults = [];

    for (const page of PAGES_TO_AUDIT) {
      console.log(`Auditing ${page.name}...`);
      
      // Desktop
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      });
      await client.send('Page.navigate', { url: page.url });
      await sleep(1500);

      const desktopCheck = await client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const hasHScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;
            const brokenButtons = Array.from(document.querySelectorAll('button, .btn')).filter(b => {
              const cs = window.getComputedStyle(b);
              const rect = b.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) return false; // hidden
              const bg = cs.backgroundColor;
              const col = cs.color;
              // Check if button text is invisible white-on-white or transparent-on-light
              const isWhiteText = col.includes('255, 255, 255') || col === 'white';
              const isTransBg = bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
              return isWhiteText && isTransBg;
            }).map(b => ({ tag: b.tagName, text: b.innerText.trim(), class: b.className }));
            return {
              url: window.location.href,
              title: document.title,
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              hasHScroll,
              brokenButtons
            };
          })()
        `,
        returnByValue: true
      });

      const desktopShot = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(ARTIFACTS_DIR, `audit_${page.name}_desktop.png`), Buffer.from(desktopShot.data, 'base64'));

      // Mobile
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true
      });
      await sleep(800);

      const mobileCheck = await client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const hasHScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;
            return {
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              hasHScroll
            };
          })()
        `,
        returnByValue: true
      });

      const mobileShot = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(ARTIFACTS_DIR, `audit_${page.name}_mobile.png`), Buffer.from(mobileShot.data, 'base64'));

      auditResults.push({
        page: page.name,
        desktop: desktopCheck.result.value,
        mobile: mobileCheck.result.value
      });
    }

    console.log('AUDIT SUMMARY:');
    console.log(JSON.stringify(auditResults, null, 2));
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'page_audit_results.json'), JSON.stringify(auditResults, null, 2));

    await client.close();
  } finally {
    chromeProcess.kill('SIGKILL');
  }
}

run().catch(console.error);
