const http = require('http');

const req = http.get('http://localhost:3000/login', (res) => {
  console.log('HTTP Status Code:', res.statusCode);
  console.log('Content-Type:', res.headers['content-type']);
  console.log('Set-Cookie Header present:', Boolean(res.headers['set-cookie']));
  
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    console.log('Body Length (bytes):', data.length);
    console.log('Contains "Spark Admin":', data.includes('Spark Admin'));
    console.log('Contains login form:', data.includes('<form') && data.includes('action="/login"'));
    console.log('Contains CSRF token:', data.includes('name="_csrf"'));
  });
});

req.on('error', (err) => {
  console.error('Request failed:', err.message);
  process.exit(1);
});
