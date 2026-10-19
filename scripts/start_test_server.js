process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
require('dotenv').config({ path: '.env.test', override: true });

require('../app/server');
