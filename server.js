'use strict';

const http = require('node:http');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function handle(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

function createServer() {
  return http.createServer(handle);
}

function portFromEnv() {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '' || Number.isNaN(Number(raw))) return 3000;
  return Number(raw);
}

if (require.main === module) {
  const server = createServer();
  server.listen(portFromEnv(), () => {
    console.log(`listening on port ${server.address().port}`);
  });
}

module.exports = { createServer, handle };

