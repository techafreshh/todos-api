'use strict';

const http = require('node:http');

// In-memory store keyed by id. Ids come from a counter that only increments
// (even when entries get deleted), so they are never reused.
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

// 204 must carry no body, so this deliberately writes only the status line —
// no Content-Type and no Content-Length that would promise one.
function sendNoContent(res) {
  res.writeHead(204);
  res.end();
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

// PATCH /todos/<id>: the body must be exactly {"status":"done"} or
// {"status":"open"}. Validation precedes the id lookup, so an invalid body
// is 400 even toward an unknown id — stable ordering, mirroring create's
// validate-everything-then-touch-state shape.
async function handlePatch(req, res, id) {
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
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { error: 'invalid body' });
    return;
  }
  // Exactly one key named `status`: rejects missing, extra and unknown-named
  // fields in one check.
  if (Object.keys(parsed).length !== 1 || parsed.status === undefined) {
    sendJson(res, 400, { error: 'invalid body' });
    return;
  }
  // Case-sensitive: only the exact lowercase literals transition a todo.
  if (parsed.status !== 'done' && parsed.status !== 'open') {
    sendJson(res, 400, { error: 'invalid status' });
    return;
  }
  const todo = todos.get(id);
  if (todo === undefined) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  // Mutate in place so the response carries every field of the stored todo.
  todo.status = parsed.status;
  sendJson(res, 200, todo);
}

// DELETE /todos/<id>: remove the entry and answer 204 with no body. The id
// counter never moves backward, so deleted ids are never allocated again.
async function handleDelete(req, res, id) {
  // The request body is ignored, but still drained for keep-alive hygiene.
  await drainBody(req);
  if (!todos.delete(id)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  sendNoContent(res);
}

// Serves POST /todos, PATCH and DELETE /todos/<id>, and GET /health; every
// other route (including GET /todos, issue #4) is 404 per the issue contract.
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
    const idMatch = pathname.match(/^\/todos\/(\d+)$/);
    if (idMatch && req.method === 'PATCH') {
      await handlePatch(req, res, Number(idMatch[1]));
      return;
    }
    if (idMatch && req.method === 'DELETE') {
      await handleDelete(req, res, Number(idMatch[1]));
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
