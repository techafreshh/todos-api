'use strict';

// Conformance audit battery for GET /todos (issue #13, PRD.md "Read (list +
// query semantics)" and "Mutate"): spawn the real server process and speak
// HTTP to it, never import internals (README "Operating model"). Each test
// gets a fresh server, so allocated ids always restart at 1. Helpers are
// duplicated per test file, as in cursor.test.js and list.test.js.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const READY_TIMEOUT_MS = 5000;

// The cursor is the base64 of the last item's id (issue #5).
const encodeId = (id) => Buffer.from(String(id), 'utf8').toString('base64');

function startServer() {
  // PORT=0 asks the OS for an ephemeral port, so parallel runs never collide.
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error(`server not ready after ${READY_TIMEOUT_MS}ms; stdout: ${buffer}`)),
      READY_TIMEOUT_MS,
    );
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/listening on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}; stdout: ${buffer}`));
    });
  });
  const stop = () => {
    child.kill();
    return new Promise((resolve) => child.once('exit', resolve));
  };
  return { ready, stop };
}

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/todos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: res.status, body: await res.json() };
}

async function get(port, query = '') {
  const res = await fetch(`http://127.0.0.1:${port}/todos${query}`);
  return { status: res.status, body: await res.json() };
}

async function patch(port, id, body) {
  const res = await fetch(`http://127.0.0.1:${port}/todos/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function del(port, id) {
  const res = await fetch(`http://127.0.0.1:${port}/todos/${id}`, { method: 'DELETE' });
  // 204 carries an empty body: read text, never res.json().
  return { status: res.status, text: await res.text() };
}

async function createTodos(port, specs) {
  const created = [];
  for (const spec of specs) {
    const { status, body } = await post(port, JSON.stringify(spec));
    assert.strictEqual(status, 201);
    created.push(body);
  }
  return created;
}

// Per survival.test.js: after every bad request the same untouched process
// must still answer GET /health with 200 {"ok":true}.
async function expectSurvive(port) {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true });
}

test('audit: priority ties break id-ascending in BOTH orders (7 todos, heavy ties)', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    // Priorities [3,1,5,1,2,5,3] on ids 1..7: two priority-1, one priority-2,
    // two priority-3 and two priority-5 ties.
    await createTodos(port, [
      { title: 'p3a', priority: 3 },
      { title: 'p1a', priority: 1 },
      { title: 'p5a', priority: 5 },
      { title: 'p1b', priority: 1 },
      { title: 'p2', priority: 2 },
      { title: 'p5b', priority: 5 },
      { title: 'p3b', priority: 3 },
    ]);
    const asc = await get(port, '?sort=priority&limit=100');
    const desc = await get(port, '?sort=priority&order=desc&limit=100');
    assert.strictEqual(asc.status, 200);
    assert.strictEqual(desc.status, 200);
    // asc: 1s (ids 2,4), 2 (5), 3s (1,7), 5s (3,6) — every tie id-ascending.
    assert.deepStrictEqual(asc.body.items.map((t) => t.id), [2, 4, 5, 1, 7, 3, 6]);
    // desc negates ONLY the priority; both ties keep id-ascending (PRD.md
    // "ties break by id ascending, always (in both orders)").
    assert.deepStrictEqual(desc.body.items.map((t) => t.id), [3, 6, 1, 7, 5, 2, 4]);
  } finally {
    await stop();
  }
});

test('audit: parameter order is irrelevant, including with a cursor', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [
      { title: 'p3', priority: 3 },
      { title: 'p1', priority: 1 },
      { title: 'p5', priority: 5 },
      { title: 'p2', priority: 2 },
    ]);
    const done = await patch(port, 3, { status: 'done' });
    assert.strictEqual(done.status, 200);
    // Canonical ordering of the five PRD parameters.
    const canonical = await get(port, '?sort=priority&order=desc&status=open&limit=2');
    assert.strictEqual(canonical.status, 200);
    const canonicalNext = await get(
      port,
      `?sort=priority&order=desc&status=open&limit=2&cursor=${canonical.body.nextCursor}`,
    );
    // Scrambled ordering of the exact same parameters must return byte-for-byte
    // the same page: "combined in any order" includes the cursor parameter.
    const scrambled = await get(
      port,
      `?limit=2&order=desc&sort=priority&cursor=${canonical.body.nextCursor}&status=open`,
    );
    assert.strictEqual(scrambled.status, 200);
    assert.deepStrictEqual(scrambled.body, canonicalNext.body);
    // And the canonical page itself follows priority-desc with id-asc ties:
    // open ids 1 (p3), 2 (p1), 4 (p2) → desc full order [1,4,2], p5 is done.
    assert.deepStrictEqual(canonical.body.items.map((t) => t.id), [1, 4]);
    assert.deepStrictEqual(canonicalNext.body.items.map((t) => t.id), [2]);
    assert.strictEqual(canonicalNext.body.nextCursor, null);
  } finally {
    await stop();
  }
});

test('audit: every invalid parameter answers 400 — even combined with a valid cursor — and /health stays up', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }]);
    const first = await get(port, '?limit=2');
    assert.strictEqual(first.status, 200);
    const validCursor = first.body.nextCursor;
    // Each bad value rides along with other (valid) parameters, so a silently
    // ignored parameter or a 500 would slip through a weaker probe.
    const battery = [
      `?status=banana&cursor=${validCursor}`,
      `?sort=name&cursor=${validCursor}`,
      `?order=sideways&cursor=${validCursor}`,
      `?limit=0&cursor=${validCursor}`,
      `?limit=101&cursor=${validCursor}`,
      `?limit=2.5&cursor=${validCursor}`,
      '?cursor=@@@&sort=priority&order=desc&limit=5&status=open',
      '?status=banana&sort=name&order=sideways&limit=0&cursor=@@@',
    ];
    for (const query of battery) {
      const { status, body } = await get(port, query);
      assert.strictEqual(status, 400, `expected 400 for ${query}`);
      assert.ok('error' in body, `expected an "error" key for ${query}, got ${JSON.stringify(body)}`);
      await expectSurvive(port);
    }
  } finally {
    await stop();
  }
});

test('audit: a deleted anchor never reappears — the walk yields the stable empty page', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }, { title: 't4' }, { title: 't5' }]);
    const page1 = await get(port, '?limit=2');
    assert.deepStrictEqual(page1.body.items.map((t) => t.id), [1, 2]);
    const gone = await del(port, 2);
    assert.strictEqual(gone.status, 204);
    // Re-paging the deleted anchor: id 2 is gone from the store, so the page
    // is empty — never a silent reslice of the head restarting at items [1,3].
    const repaged = await get(port, `?limit=2&cursor=${page1.body.nextCursor}`);
    assert.deepStrictEqual(repaged.body, { items: [], nextCursor: null });
    // And the empty page is stable on repeat.
    const again = await get(port, `?limit=2&cursor=${page1.body.nextCursor}`);
    assert.deepStrictEqual(again.body, repaged.body);
  } finally {
    await stop();
  }
});

test('audit: an anchor filtered out mid-walk (open→done) yields the empty page under status=open', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }, { title: 't4' }]);
    const page1 = await get(port, '?status=open&limit=2');
    assert.deepStrictEqual(page1.body.items.map((t) => t.id), [1, 2]);
    const patched = await patch(port, 2, { status: 'done' });
    assert.strictEqual(patched.status, 200);
    // The anchor id 2 no longer matches status=open, so "strictly after the
    // anchor in the requested ordering" is over an empty set — no restart.
    const repaged = await get(port, `?status=open&limit=2&cursor=${page1.body.nextCursor}`);
    assert.deepStrictEqual(repaged.body, { items: [], nextCursor: null });
  } finally {
    await stop();
  }
});

test('audit: list, patch and re-delete all agree a deleted id is gone; allocation skips it', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }, { title: 't4' }]);
    const gone = await del(port, 2);
    assert.strictEqual(gone.status, 204);
    assert.strictEqual(gone.text, '');
    // Listing never resurfaces the id.
    const listed = await get(port, '?limit=100');
    assert.strictEqual(listed.status, 200);
    assert.deepStrictEqual(listed.body.items.map((t) => t.id), [1, 3, 4]);
    // Patching it is 404, not a resurrected todo.
    const patched = await patch(port, 2, { status: 'done' });
    assert.strictEqual(patched.status, 404);
    assert.ok('error' in patched.body);
    // Repeating the delete is 404 too.
    const reDeleted = await del(port, 2);
    assert.strictEqual(reDeleted.status, 404);
    // The monotonic counter skips the deleted id forever: next create is 5.
    const fifth = await post(port, JSON.stringify({ title: 't5' }));
    assert.strictEqual(fifth.status, 201);
    assert.strictEqual(fifth.body.id, 5);
    const relisted = await get(port, '?limit=100');
    assert.deepStrictEqual(relisted.body.items.map((t) => t.id), [1, 3, 4, 5]);
    await expectSurvive(port);
  } finally {
    await stop();
  }
});

test('audit: nextCursor is null exactly when fewer than limit items were returned', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }]);
    // A full page (2 = limit) promises more via its last id's cursor.
    const page1 = await get(port, '?limit=2');
    assert.deepStrictEqual(page1.body.items.map((t) => t.id), [1, 2]);
    assert.strictEqual(page1.body.nextCursor, encodeId(2)); // full page → cursor
    // The tail page (1 < limit 2) is where the walk ends.
    const page2 = await get(port, `?limit=2&cursor=${page1.body.nextCursor}`);
    assert.deepStrictEqual(page2.body.items.map((t) => t.id), [3]);
    assert.strictEqual(page2.body.nextCursor, null);
    // An exactly-full final page still emits a cursor (count-based rule)…
    const full = await get(port, '?limit=3');
    assert.deepStrictEqual(full.body.items.map((t) => t.id), [1, 2, 3]);
    assert.strictEqual(full.body.nextCursor, encodeId(3));
    // …and re-paging that cursor answers the stable empty tail page.
    const tail = await get(port, `?limit=3&cursor=${full.body.nextCursor}`);
    assert.deepStrictEqual(tail.body, { items: [], nextCursor: null });
  } finally {
    await stop();
  }
});
