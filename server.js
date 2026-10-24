'use strict';

const http = require('node:http');

// In-memory store keyed by id. Ids come from a counter that only increments
// (even when entries get deleted by a later issue), so they are never reused.
const todos = new Map();
let nextId = 1;

// Cap on how much request body we are willing to buffer: larger bodies drain
// but are discarded, so a hostile upload can never exhaust the process.
const MAX_BODY_BYTES = 1024 * 1024;

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

// Consume the request body for the create path: resolves { buffer, overflow }
// where buffer holds at most MAX_BODY_BYTES bytes and overflow is true once
// the body exceeded the cap (storing stops, draining continues). Stream
// errors resolve instead of rejecting — per drainBody above, rejecting once
// killed the whole process on mid-body client aborts.
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    const finish = () => resolve({ buffer: Buffer.concat(chunks), overflow });
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else overflow = true;
    });
    req.once('error', finish);
    req.once('end', finish);
    req.resume();
  });
}

// Second-precision RFC3339 UTC: toISOString carries .mmm milliseconds, which
// would leak into the createdAt the issue's format requires.
function nowRfc3339() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// POST /todos: validate the input boundary, then allocate an id and store.
// Rejected requests must never consume an id, so nextId only advances after
// every check has passed.
async function handleCreate(req, res) {
  const { buffer, overflow } = await readBody(req);
  if (overflow) {
    sendJson(res, 400, { error: 'payload too large' });
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'malformed JSON' });
    return;
  }
  // Guard `parsed === null` (valid JSON whose .title access would throw);
  // every other non-object fails the same title check via this condition.
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.title !== 'string') {
    sendJson(res, 400, { error: 'invalid title' });
    return;
  }
  const title = parsed.title.trim();
  if (title.length < 1 || title.length > 200) {
    sendJson(res, 400, { error: 'invalid title' });
    return;
  }
  // Default applies only when the key is absent; Number.isInteger rejects
  // "3", 2.5, booleans and null in one shot (PRD boundary: ints only).
  const priority = parsed.priority === undefined ? 3 : parsed.priority;
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    sendJson(res, 400, { error: 'invalid priority' });
    return;
  }
  const id = nextId++;
  const todo = { id, title, priority, status: 'open', createdAt: nowRfc3339() };
  todos.set(id, todo);
  sendJson(res, 201, todo);
}

// Serves POST /todos and GET /health; every other route (including GET
// /todos, a later issue) is 404 per the issue contract.
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
    if (req.method === 'POST' && pathname === '/todos') {
      await handleCreate(req, res);
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
