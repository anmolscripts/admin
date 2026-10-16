const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = path.join(__dirname, '../.cdp_profile_dark');
const ARTIFACTS_DIR = 'C:/Users/User/.gemini/antigravity-ide/brain/efee2647-5f99-4f7a-8130-661aacf061e1';
const PORT = 9226;

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
  console.log('Testing dark mode...');
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

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    // Dark mode on /login
    await client.send('Page.navigate', { url: 'http://localhost:3000/login' });
    await sleep(1000);
    await client.send('Runtime.evaluate', {
      expression: `document.documentElement.setAttribute('data-theme', 'dark')`
    });
    await sleep(500);
    const loginDarkShot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'dark_login_desktop.png'), Buffer.from(loginDarkShot.data, 'base64'));

    // Log in
    await client.send('Runtime.evaluate', {
      expression: `
        (() => {
          document.getElementById('email').value = 'admin@email.com';
          document.getElementById('password').value = 'super-secret-password-2026';
          document.getElementById('loginForm').submit();
        })()
      `
    });
    await sleep(2000);

    // Dashboard in dark mode
    await client.send('Page.navigate', { url: 'http://localhost:3000/dashboard' });
    await sleep(1000);
    await client.send('Runtime.evaluate', {
      expression: `
        (() => {
          localStorage.setItem('spark-theme', 'dark');
          document.documentElement.setAttribute('data-theme', 'dark');
        })()
      `
    });
    await sleep(500);
    const dashDarkShot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'dark_dashboard_desktop.png'), Buffer.from(dashDarkShot.data, 'base64'));

    // Documents in dark mode
    await client.send('Page.navigate', { url: 'http://localhost:3000/documents' });
    await sleep(1000);
    await client.send('Runtime.evaluate', {
      expression: `document.documentElement.setAttribute('data-theme', 'dark')`
    });
    await sleep(500);
    const docsDarkShot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'dark_documents_desktop.png'), Buffer.from(docsDarkShot.data, 'base64'));

    console.log('Saved dark mode screenshots successfully!');
    await client.close();
  } finally {
    chromeProcess.kill('SIGKILL');
  }
}

run().catch(console.error);
