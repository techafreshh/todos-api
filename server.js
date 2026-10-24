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

// Consume (and discard) the request body before responding so keep-alive and
// pipelined clients never hit node:http's bare-400 socket teardown on an
// unconsumed body (PRD §Errors: survive every bad request and keep serving
// /health immediately after). Riskier alternatives — resolving only on 'end'
// and rejecting on 'error' — can raise an unhandled rejection when the client
// tears the connection down mid-body, killing the whole process; an error
// here must resolve instead.
function drainBody(req) {
  return new Promise((resolve) => {
    req.once('error', resolve);
    req.once('end', resolve);
    req.resume();
  });
}

// This lap serves only GET /health; every other route (including /todos,
// reserved for a later issue) is 404 per the issue contract.
async function handle(req, res) {
  try {
    res.once('error', () => {}); // a dying socket must never crash the process
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      await drainBody(req);
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await drainBody(req);
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch {
    // The process must never leak a 500 (PRD §Errors).
    if (!res.headersSent) sendJson(res, 404, { error: 'not found' });
    else res.end();
  }
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
