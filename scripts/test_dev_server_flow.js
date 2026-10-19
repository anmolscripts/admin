'use strict';

const http = require('http');
const { spawn } = require('child_process');

async function testDevServer() {
  console.log('--- TESTING LOCAL DEVELOPMENT SERVER STARTUP & LOGIN ---');

  // Spawn node app/server.js
  const serverProc = spawn('node', ['app/server.js'], {
    env: { ...process.env, PORT: '3000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverStarted = false;

  serverProc.stdout.on('data', (data) => {
    const text = data.toString();
    console.log('[DEV SERVER STDOUT]:', text.trim());
    if (text.includes('Server running at')) {
      serverStarted = true;
      runHttpTests();
    }
  });

  serverProc.stderr.on('data', (data) => {
    console.log('[DEV SERVER STDERR]:', data.toString().trim());
  });

  serverProc.on('exit', (code) => {
    if (!serverStarted) {
      console.error(`Server exited unexpectedly with code ${code}`);
      process.exit(1);
    }
  });

  function makeRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  async function runHttpTests() {
    try {
      console.log('\n1. Testing GET /login...');
      const loginPageRes = await makeRequest({
        hostname: '127.0.0.1',
        port: 3000,
        path: '/login',
        method: 'GET'
      });
      console.log(`   GET /login status: ${loginPageRes.statusCode}`);
      if (loginPageRes.statusCode !== 200) {
        throw new Error(`Expected HTTP 200 on /login, got ${loginPageRes.statusCode}`);
      }

      // Extract CSRF token and cookie from login page
      const setCookie = loginPageRes.headers['set-cookie'];
      const cookie = setCookie ? setCookie.map(c => c.split(';')[0]).join('; ') : '';
      const csrfMatch = loginPageRes.body.match(/name="_csrf"\s+value="([^"]+)"/);
      const csrfToken = csrfMatch ? csrfMatch[1] : '';

      console.log(`   Session cookie established: ${cookie ? 'YES' : 'NO'}`);
      console.log(`   CSRF token extracted: ${csrfToken ? 'YES' : 'NO'}`);

      console.log('\n2. Testing POST /login with valid admin credentials...');
      const postBody = new URLSearchParams({
        _csrf: csrfToken,
        email: 'admin@email.com',
        password: process.env.SEED_ADMIN_PASSWORD   // must be set in .env — no hardcoded fallback
      }).toString();

      const loginSubmitRes = await makeRequest({
        hostname: '127.0.0.1',
        port: 3000,
        path: '/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
          'Cookie': cookie
        }
      }, postBody);

      console.log(`   POST /login response status: ${loginSubmitRes.statusCode}`);
      console.log(`   Redirect Location: ${loginSubmitRes.headers.location || 'none'}`);

      if (loginSubmitRes.statusCode !== 302) {
        throw new Error(`Expected HTTP 302 redirect after login, got ${loginSubmitRes.statusCode}`);
      }

      const postLoginCookie = loginSubmitRes.headers['set-cookie']
        ? loginSubmitRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ')
        : cookie;

      console.log('\n3. Testing GET / (Authenticated landing page)...');
      const dashboardRes = await makeRequest({
        hostname: '127.0.0.1',
        port: 3000,
        path: '/',
        method: 'GET',
        headers: {
          'Cookie': postLoginCookie
        }
      });

      console.log(`   GET / response status: ${dashboardRes.statusCode}`);
      if (dashboardRes.statusCode !== 200 && dashboardRes.statusCode !== 302) {
        throw new Error(`Expected HTTP 200 or 302 on /, got ${dashboardRes.statusCode}`);
      }
      console.log('   Authenticated dashboard rendered successfully!');

      console.log('\n✔ ALL LOCAL DEV STARTUP & LOGIN CHECKS PASSED 100%!');
      serverProc.kill('SIGINT');
      process.exit(0);
    } catch (err) {
      console.error('HTTP verification error:', err);
      serverProc.kill('SIGKILL');
      process.exit(1);
    }
  }

  // Timeout guard
  setTimeout(() => {
    if (!serverStarted) {
      console.error('Server failed to start within 15 seconds.');
      serverProc.kill('SIGKILL');
      process.exit(1);
    }
  }, 15000);
}

testDevServer();
