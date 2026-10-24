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

// The exact desc ordering the acceptance arrays demand is the full reversal
// of asc — id tie-break included:
//   priorities 5,1,1 (ids 1,2,3): asc [2,3,1], desc [1,3,2] (tie 1,1 flips to id 3,2);
//   same-second createdAt (ids 1,2): asc [1,2], desc [2,1].
// The prose "ties always break by id ascending, in both orders" contradicts
// those arrays (it would yield [1,2,3] and [1,2]); the machine-checked arrays win.
// One comparator over (sort field, id) multiplied by dir covers both orders.
// Cursor codec (issue #5). A cursor is the plain base64 of the last item's
// id as decimal digits: opaque to the client, and carrying no query state —
// status/sort/order are always interpreted from the current request, so the
// page is "ids strictly after the anchor in the ordering asked for now" and
// therefore stable across intervening creates.
function encodeCursor(id) {
  return Buffer.from(String(id), 'utf8').toString('base64');
}

// Strict decode: null (→ 400 "invalid cursor") for anything that is not
// exactly the canonical base64 of a positive safe integer id. Node's base64
// decoder alone is too lenient — it silently skips stray characters and
// accepts non-canonical padding — so validity is pinned down layer by layer:
// charset regex, non-empty decode, re-encode-must-round-trip (rejects
// 'mg==', 'Mg', 'Mg==x'), digits-only-as-1..N (rejects '0', '-1', '02',
// '@@@', arbitrary text) and the safe-integer cap.
function decodeCursor(cursor) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cursor)) return null;
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  if (encodeCursor(decoded) !== cursor) return null;
  if (!/^[1-9]\d*$/.test(decoded)) return null;
  const id = Number(decoded);
  if (!Number.isSafeInteger(id)) return null;
  return id;
}

async function handleList(req, res, searchParams) {
  // The request body is ignored, but still drained for keep-alive hygiene.
  await drainBody(req);
  // Validate everything before touching the store, mirroring handleCreate;
  // a malformed parameter answers 400 without reading later ones. Absence
  // (null) takes the default; an empty value ("?sort=") is a present-but-
  // invalid parameter and rejects, never silently ignored.
  const status = searchParams.get('status');
  if (status !== null && status !== 'open' && status !== 'done') {
    sendJson(res, 400, { error: 'invalid status' });
    return;
  }
  const sort = searchParams.get('sort') ?? 'createdAt';
  if (sort !== 'priority' && sort !== 'createdAt') {
    sendJson(res, 400, { error: 'invalid sort' });
    return;
  }
  const order = searchParams.get('order') ?? 'asc';
  if (order !== 'asc' && order !== 'desc') {
    sendJson(res, 400, { error: 'invalid order' });
    return;
  }
  // Strict integer digits: rejects -1, 2.5, '1e2' and '' in one regex, then
  // the 1..100 range caps the page size.
  const limitRaw = searchParams.get('limit') ?? '20';
  if (!/^\d+$/.test(limitRaw)) {
    sendJson(res, 400, { error: 'invalid limit' });
    return;
  }
  const limit = Number(limitRaw);
  if (limit < 1 || limit > 100) {
    sendJson(res, 400, { error: 'invalid limit' });
    return;
  }
  // Same ladder position as the limit check: a cursor, when present, must
  // decode before the store is touched — a garbage cursor is a client error
  // ("?cursor=" included, mirroring "?limit=" as present-but-invalid), never
  // a silent restart at page one.
  const cursorRaw = searchParams.get('cursor');
  let cursorId = null;
  if (cursorRaw !== null) {
    cursorId = decodeCursor(cursorRaw);
    if (cursorId === null) {
      sendJson(res, 400, { error: 'invalid cursor' });
      return;
    }
  }
  const dir = order === 'desc' ? -1 : 1;
  // createdAt is canonical second-precision RFC3339 UTC (nowRfc3339), so the
  // string comparison IS the chronological one; no Date.parse.
  const comparePrimary =
    sort === 'priority'
      ? (a, b) => a.priority - b.priority
      : (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  const items = [...todos.values()]
    .filter((todo) => status === null || todo.status === status)
    .sort((a, b) => dir * (comparePrimary(a, b) || (a.id - b.id)));
  // Page slicing by id anchor in the already-sorted array: with a cursor the
  // page is every item strictly after the anchor's position in THIS request's
  // ordering — creations that land after the anchor can never shift it. An
  // anchor that no longer exists in the filtered set (deleted or filtered
  // out mid-walk) yields an empty page, never a reslice of the head which
  // would restart the walk at page one.
  let page;
  if (cursorId === null) {
    page = items.slice(0, limit);
  } else {
    const anchorIndex = items.findIndex((todo) => todo.id === cursorId);
    page = anchorIndex === -1 ? [] : items.slice(anchorIndex + 1, anchorIndex + 1 + limit);
  }
  // nextCursor is purely count-based: a full page promises more (re-paging an
  // exactly-full tail deterministically re-answers the stable empty page),
  // anything short means the walk is over.
  const nextCursor = page.length < limit ? null : encodeCursor(page[page.length - 1].id);
  sendJson(res, 200, { items: page, nextCursor });
}

// Serves POST and GET /todos, PATCH and DELETE /todos/<id>, and GET /health;
// every other route is 404 per the issue contract.
async function handle(req, res) {
  try {
    // One response object may emit several 'error' events in a row (e.g. a
    // write-after-end followed by the socket tearing down); `on` keeps a
    // listener attached for every emission so none of them lands on zero
    // listeners as an unhandled 'error' event — that would raise
    // uncaughtException and kill the process, which PRD §Errors forbids.
    res.on('error', () => {});
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      await drainBody(req);
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const { pathname } = url;
    if (req.method === 'POST' && pathname === '/todos') {
      await handleCreate(req, res);
      return;
    }
    // Before the shared drainBody below: handleList drains its own request
    // body, and a second drainBody on an already-ended stream never resolves.
    if (req.method === 'GET' && pathname === '/todos') {
      await handleList(req, res, url.searchParams);
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
