'use strict';

// Black-box tests for cursor pagination on GET /todos (issue #5): spawn the
// real server process and speak HTTP to it, never import internals (README
// "Operating model"). Each test gets a fresh server, so allocated ids always
// restart at 1. Helpers are duplicated per test file, as in list.test.js.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const READY_TIMEOUT_MS = 5000;

// The cursor is the last item's id as a plain base-10 string (PRD.md
// Pagination semantics: "cursor is the last item's id from the previous
// page"): the tests pin the exact renderings the server must emit
// ('2' for id 2, '4' for id 4, ...).
const encodeId = (id) => String(id);

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

async function createTodos(port, specs) {
  const created = [];
  for (const spec of specs) {
    const { status, body } = await post(port, JSON.stringify(spec));
    assert.strictEqual(status, 201);
    created.push(body);
  }
  return created;
}

test('first page: 5 todos, limit=2 gives ids [1,2] and nextCursor is the plain id "2"', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }, { title: 't4' }, { title: 't5' }]);
    const { status, body } = await get(port, '?limit=2');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(Object.keys(body), ['items', 'nextCursor']);
    assert.deepStrictEqual(body.items.map((t) => t.id), [1, 2]);
    // The cursor is exactly the last item's id as a decimal string — it must
    // round-trip verbatim through ?cursor= below.
    assert.strictEqual(body.nextCursor, encodeId(2));
    assert.strictEqual(body.nextCursor, '2');
  } finally {
    await stop();
  }
});

test('intervening create cannot shift the page: cursor at id 2 still yields [3,4] after a 6th todo', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }, { title: 't4' }, { title: 't5' }]);
    const first = await get(port, '?limit=2');
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(first.body.items.map((t) => t.id), [1, 2]);
    const { status: createdStatus } = await post(port, JSON.stringify({ title: 'later arrival' }));
    assert.strictEqual(createdStatus, 201); // id 6
    const { status, body } = await get(port, `?limit=2&cursor=${first.body.nextCursor}`);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.items.map((t) => t.id), [3, 4]);
    assert.strictEqual(body.nextCursor, encodeId(4));
  } finally {
    await stop();
  }
});

test('re-requesting the same cursor returns the identical page, byte for byte', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }, { title: 't4' }, { title: 't5' }]);
    const { status } = await post(port, JSON.stringify({ title: 't6' }));
    assert.strictEqual(status, 201);
    const query = '?limit=2&cursor=2';
    const first = await get(port, query);
    const second = await get(port, query);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    // The whole body — items in order, nextCursor, key order — repeats exactly.
    assert.deepStrictEqual(second.body, first.body);
  } finally {
    await stop();
  }
});

test('third page of 5 todos at limit=2 is short: ids [5], nextCursor null', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }, { title: 't4' }, { title: 't5' }]);
    const page1 = await get(port, '?limit=2');
    const page2 = await get(port, `?limit=2&cursor=${page1.body.nextCursor}`);
    assert.deepStrictEqual(page2.body.items.map((t) => t.id), [3, 4]);
    const page3 = await get(port, `?limit=2&cursor=${page2.body.nextCursor}`);
    assert.strictEqual(page3.status, 200);
    assert.deepStrictEqual(page3.body.items.map((t) => t.id), [5]);
    assert.strictEqual(page3.body.nextCursor, null);
  } finally {
    await stop();
  }
});

test('exactly-full last page still emits a cursor; re-paging it gives the stable empty page', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }, { title: 't4' }]);
    const page1 = await get(port, '?limit=2');
    assert.deepStrictEqual(page1.body.items.map((t) => t.id), [1, 2]);
    const page2 = await get(port, `?limit=2&cursor=${page1.body.nextCursor}`);
    assert.deepStrictEqual(page2.body.items.map((t) => t.id), [3, 4]);
    // page filled limit exactly: the count-based rule still emits its last id.
    assert.strictEqual(page2.body.nextCursor, encodeId(4));
    const page3 = await get(port, `?limit=2&cursor=${page2.body.nextCursor}`);
    assert.deepStrictEqual(page3.body, { items: [], nextCursor: null });
    // and the empty page is stable on repeat, so clients can walk safely.
    const repeat = await get(port, `?limit=2&cursor=${page2.body.nextCursor}`);
    assert.deepStrictEqual(repeat.body, page3.body);
  } finally {
    await stop();
  }
});

test('cursor is anchored in the requested ordering, not the id order (priority asc)', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [
      { title: 'p3', priority: 3 },
      { title: 'p1a', priority: 1 },
      { title: 'p5', priority: 5 },
      { title: 'p1b', priority: 1 },
      { title: 'p2', priority: 2 },
    ]);
    // priority asc with id-asc ties: [2,4] (p1), [5] (p2), [1] (p3), [3] (p5).
    const page1 = await get(port, '?sort=priority&limit=2');
    assert.deepStrictEqual(page1.body.items.map((t) => t.id), [2, 4]);
    assert.strictEqual(page1.body.nextCursor, encodeId(4));
    const page2 = await get(port, `?sort=priority&limit=2&cursor=${page1.body.nextCursor}`);
    assert.deepStrictEqual(page2.body.items.map((t) => t.id), [5, 1]);
    assert.strictEqual(page2.body.nextCursor, encodeId(1));
    const page3 = await get(port, `?sort=priority&limit=2&cursor=${page2.body.nextCursor}`);
    assert.deepStrictEqual(page3.body.items.map((t) => t.id), [3]);
    assert.strictEqual(page3.body.nextCursor, null);
  } finally {
    await stop();
  }
});

test('priority-sort walk is stable across an intervening create: cursor at id 4 yields [5,1] then [6,3]', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [
      { title: 'p3', priority: 3 },
      { title: 'p1a', priority: 1 },
      { title: 'p5', priority: 5 },
      { title: 'p1b', priority: 1 },
      { title: 'p2', priority: 2 },
    ]);
    // priority asc, ties id ascending: [2,4] (p1), [5] (p2), [1] (p3), [3] (p5).
    const page1 = await get(port, '?sort=priority&limit=2');
    assert.deepStrictEqual(page1.body.items.map((t) => t.id), [2, 4]);
    assert.strictEqual(page1.body.nextCursor, encodeId(4));
    // A priority-4 todo lands BETWEEN the page-1 anchor and p5 in the
    // ordering; the anchor is positional, so it cannot push the next page.
    const arrived = await post(port, JSON.stringify({ title: 'later p4', priority: 4 }));
    assert.strictEqual(arrived.status, 201); // id 6
    const page2 = await get(port, `?sort=priority&limit=2&cursor=${page1.body.nextCursor}`);
    assert.deepStrictEqual(page2.body.items.map((t) => t.id), [5, 1]);
    assert.strictEqual(page2.body.nextCursor, encodeId(1));
    const page3 = await get(port, `?sort=priority&limit=2&cursor=${page2.body.nextCursor}`);
    assert.deepStrictEqual(page3.body.items.map((t) => t.id), [6, 3]);
    // Exactly limit items: the count-based rule emits a cursor even at the end
    // of the ordering; re-paging it answers the stable empty tail page.
    assert.strictEqual(page3.body.nextCursor, encodeId(3));
    const tail = await get(port, `?sort=priority&limit=2&cursor=${page3.body.nextCursor}`);
    assert.deepStrictEqual(tail.body, { items: [], nextCursor: null });
    // Every todo appears exactly once across the walk: no duplicates, no misses.
    assert.deepStrictEqual(
      [...page1.body.items, ...page2.body.items, ...page3.body.items].map((t) => t.id).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6],
    );
  } finally {
    await stop();
  }
});

test('same anchoring under order=desc: pages continue from the cursor in desc order', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [
      { title: 'p3', priority: 3 },
      { title: 'p1a', priority: 1 },
      { title: 'p5', priority: 5 },
      { title: 'p1b', priority: 1 },
      { title: 'p2', priority: 2 },
    ]);
    // desc negates only the priority; the (1,1) tie stays id ascending:
    // full order [3,1,5,2,4] — p5, p3, p2, then p1 as ids 2,4 (issue #13).
    const page1 = await get(port, '?sort=priority&order=desc&limit=2');
    assert.deepStrictEqual(page1.body.items.map((t) => t.id), [3, 1]);
    assert.strictEqual(page1.body.nextCursor, encodeId(1));
    const page2 = await get(port, `?sort=priority&order=desc&limit=2&cursor=${page1.body.nextCursor}`);
    assert.deepStrictEqual(page2.body.items.map((t) => t.id), [5, 2]);
    assert.strictEqual(page2.body.nextCursor, encodeId(2));
    const page3 = await get(port, `?sort=priority&order=desc&limit=2&cursor=${page2.body.nextCursor}`);
    assert.deepStrictEqual(page3.body.items.map((t) => t.id), [4]);
    assert.strictEqual(page3.body.nextCursor, null);
  } finally {
    await stop();
  }
});

test('status-filtered pages skip filtered-out items: done item never surfaces mid-walk', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 't1' }, { title: 't2' }, { title: 't3' }, { title: 't4' }, { title: 't5' }, { title: 't6' }]);
    const patched = await patch(port, 3, { status: 'done' });
    assert.strictEqual(patched.status, 200);
    const page1 = await get(port, '?status=open&limit=2');
    assert.deepStrictEqual(page1.body.items.map((t) => t.id), [1, 2]);
    const page2 = await get(port, `?status=open&limit=2&cursor=${page1.body.nextCursor}`);
    assert.deepStrictEqual(page2.body.items.map((t) => t.id), [4, 5]);
    const page3 = await get(port, `?status=open&limit=2&cursor=${page2.body.nextCursor}`);
    assert.deepStrictEqual(page3.body.items.map((t) => t.id), [6]);
    assert.strictEqual(page3.body.nextCursor, null);
    // The filtered-out id 3 appears only through its own filter's walk.
    const done = await get(port, '?status=done');
    assert.deepStrictEqual(done.body.items.map((t) => t.id), [3]);
  } finally {
    await stop();
  }
});

test('invalid cursors are 400 with an error body and the process keeps serving', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await createTodos(port, [{ title: 'one' }, { title: 'two' }]);
    const rejected = ['@@@', '', 'banana', 'mg==', 'Mg', 'MA==', 'MQ', '0', '02', '-1', '1e2', '2.5'];
    for (const cursor of rejected) {
      const { status, body } = await get(port, `?cursor=${cursor}`);
      assert.strictEqual(status, 400, `expected 400 for cursor=${JSON.stringify(cursor)}`);
      assert.ok('error' in body, `expected an "error" key, got ${JSON.stringify(body)}`);
    }
    // no restart in between: the same process still lists and still serves /health
    const after = await get(port);
    assert.strictEqual(after.status, 200);
    assert.deepStrictEqual(after.body.items.map((t) => t.id), [1, 2]);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(await health.json(), { ok: true });
  } finally {
    await stop();
  }
});
