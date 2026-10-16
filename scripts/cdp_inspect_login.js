const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = path.join(__dirname, '../.cdp_profile_login');
const ARTIFACTS_DIR = 'C:\\Users\\User\\.gemini\\antigravity-ide\\brain\\efee2647-5f99-4f7a-8130-661aacf061e1';
const PORT = 9224;

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

async function run() {
  console.log('Spawning Chrome on port', PORT);
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

    // Desktop capture
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    await client.send('Page.navigate', { url: 'http://localhost:3000/login' });
    await sleep(1500);

    const desktopEval = await client.send('Runtime.evaluate', {
      expression: `
        (() => {
          const btn = document.getElementById('btn-submit');
          const emailInput = document.getElementById('email');
          const emailLabel = document.querySelector('label[for="email"]');
          const card = document.querySelector('.login-card');
          const bRect = btn ? btn.getBoundingClientRect() : null;
          const iRect = emailInput ? emailInput.getBoundingClientRect() : null;
          const lRect = emailLabel ? emailLabel.getBoundingClientRect() : null;
          const cRect = card ? card.getBoundingClientRect() : null;
          const btnCs = btn ? window.getComputedStyle(btn) : null;
          const inCs = emailInput ? window.getComputedStyle(emailInput) : null;
          return {
            btnBg: btnCs ? btnCs.backgroundImage || btnCs.backgroundColor : null,
            btnColor: btnCs ? btnCs.color : null,
            btnHeight: bRect ? bRect.height : null,
            inRadius: inCs ? inCs.borderRadius : null,
            inBorder: inCs ? inCs.border : null,
            labelLeft: lRect ? lRect.left : null,
            inputLeft: iRect ? iRect.left : null,
            cardWidth: cRect ? cRect.width : null,
            labelLeftDiff: (lRect && iRect) ? (lRect.left - iRect.left) : null
          };
        })()
      `,
      returnByValue: true
    });

    console.log('Login Desktop Audit:', JSON.stringify(desktopEval.result.value, null, 2));

    const desktopScreenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'login_fixed_desktop.png'), Buffer.from(desktopScreenshot.data, 'base64'));

    // Mobile capture (375x812)
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true
    });

    await sleep(500);
    const mobileScreenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'login_fixed_mobile.png'), Buffer.from(mobileScreenshot.data, 'base64'));

    console.log('Saved login_fixed_desktop.png and login_fixed_mobile.png');
    await client.close();
  } finally {
    chromeProcess.kill('SIGKILL');
  }
}

run().catch(console.error);
