'use strict';

const http = require('node:http');

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Always drain the request body to the end before responding. A body left
// unconsumed makes node:http reject the next pipelined request with a bare
// "400 Bad Request" + "Connection: close" and tear the socket down, which
// breaks any client that reuses the connection (PRD §Errors: survive every
// bad request and keep serving /health immediately after). Bodies are capped
// past MAX_BODY_BYTES: the overflow is drained and discarded, never stored.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return; // keep draining so the socket stays usable
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: overflow ? null : Buffer.concat(chunks), overflow }));
    req.on('error', reject);
  });
}

// In-memory scaffold per issue #1 notes: id allocation and todo state stay
// minimal here; later issues extend routes and validation.
let nextId = 1;
const todos = [];

async function handle(req, res) {
  try {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      req.resume(); // drain anything sent so the socket stays clean
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (req.method === 'GET' && pathname === '/health') {
      req.resume(); // drain any stray body a client might attach
      sendJson(res, 200, { ok: true, status: 200 });
      return;
    }
    if (req.method === 'POST' && pathname === '/todos') {
      const { body, overflow } = await readBody(req);
      if (overflow) {
        sendJson(res, 400, { error: 'payload too large', status: 400 });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'malformed JSON', status: 400 });
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { error: 'expected a JSON object', status: 400 });
        return;
      }
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : undefined;
      if (typeof title !== 'string' || title.length < 1 || title.length > 200) {
        sendJson(res, 400, { error: 'invalid title', status: 400 });
        return;
      }
      const priority = parsed.priority === undefined ? 3 : parsed.priority;
      if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
        sendJson(res, 400, { error: 'invalid priority', status: 400 });
        return;
      }
      const todo = {
        id: nextId++,
        title,
        priority,
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      todos.push(todo);
      sendJson(res, 201, todo);
      return;
    }
    req.resume(); // drain any body so keep-alive connections survive 404s
    sendJson(res, 404, { error: 'not found' });
  } catch {
    // The process must never leak a 500 (PRD §Errors).
    if (!res.headersSent) sendJson(res, 400, { error: 'bad request' });
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
