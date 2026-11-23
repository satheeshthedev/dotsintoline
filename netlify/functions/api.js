// Netlify Function: every /api/* request is redirected here (see netlify.toml).
const serverless = require('serverless-http');
const app = require('../../src/app');

exports.handler = serverless(app, { binary: ['image/png'] });
