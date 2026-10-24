'use strict';

// Black-box tests for GET /todos (issue #4): spawn the real server process
// and speak HTTP to it, never import internals (README "Operating model").
// Each test gets a fresh server, so allocated ids always restart at 1.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const READY_TIMEOUT_MS = 5000;

// The cursor is the base64 of the last item's id (issue #5); the tests assert
// against the exact encoding the server must produce.
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

test('list defaults: all items, createdAt/id order, response carries items and nextCursor', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const first = await post(port, JSON.stringify({ title: 'one', priority: 2 }));
    const second = await post(port, JSON.stringify({ title: 'two' }));
    const third = await post(port, JSON.stringify({ title: 'three', priority: 5 }));
    assert.deepStrictEqual(
      [first.status, second.status, third.status],
      [201, 201, 201],
    );
    const { status, body } = await get(port);
    assert.strictEqual(status, 200);
    // Issue #5: every list response carries the cursor envelope, cursor or not.
    assert.deepStrictEqual(Object.keys(body), ['items', 'nextCursor']);
    assert.deepStrictEqual(body.items.map((t) => t.id), [1, 2, 3]);
    // A short page (3 < default limit 20) is the end of the walk.
    assert.strictEqual(body.nextCursor, null);
    // items carry the same shape as the POST responses.
    assert.deepStrictEqual(body.items[0], first.body);
  } finally {
    await stop();
  }
});

test('sort=priority is numeric with id-ascending ties: priorities 5,1,1 give ids [2,3,1]', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await post(port, JSON.stringify({ title: 'five', priority: 5 }));
    await post(port, JSON.stringify({ title: 'one-a', priority: 1 }));
    await post(port, JSON.stringify({ title: 'one-b', priority: 1 }));
    const { status, body } = await get(port, '?sort=priority');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.items.map((t) => t.id), [2, 3, 1]);
  } finally {
    await stop();
  }
});

test('sort=priority&order=desc reverses the whole comparator, ties included: ids [1,3,2]', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    await post(port, JSON.stringify({ title: 'five', priority: 5 }));
    await post(port, JSON.stringify({ title: 'one-a', priority: 1 }));
    await post(port, JSON.stringify({ title: 'one-b', priority: 1 }));
    const { status, body } = await get(port, '?sort=priority&order=desc');
    assert.strictEqual(status, 200);
    // The tie (ids 2,3) flips to id-descending in desc: the acceptance array
    // [1,3,2], not the prose's always-id-ascending [1,2,3].
    assert.deepStrictEqual(body.items.map((t) => t.id), [1, 3, 2]);
  } finally {
    await stop();
  }
});

test('same-second createdAt sorts chronologically; desc still puts id 2 first: ids [2,1]', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const first = await post(port, JSON.stringify({ title: 'one' }));
    const second = await post(port, JSON.stringify({ title: 'two' }));
    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 201);
    // Canonical RFC3339 strings compare chronologically whether or not the
    // same second was hit; second >= first holds either way.
    assert.ok(second.body.createdAt >= first.body.createdAt);
    const { status, body } = await get(port, '?sort=createdAt&order=desc');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.items.map((t) => t.id), [2, 1]);
  } finally {
    await stop();
  }
});

test('status filter picks one branch, and combines with sort, order and limit', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const first = await post(port, JSON.stringify({ title: 'open one', priority: 2 }));
    assert.strictEqual(first.status, 201);
    const second = await post(port, JSON.stringify({ title: 'four', priority: 4 }));
    assert.strictEqual(second.status, 201);
    const patched = await fetch(`http://127.0.0.1:${port}/todos/2`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.strictEqual(patched.status, 200);
    const done = await get(port, '?status=done');
    assert.strictEqual(done.status, 200);
    assert.deepStrictEqual(done.body.items.map((t) => t.id), [2]);
    for (const item of done.body.items) assert.strictEqual(item.status, 'done');
    const open = await get(port, '?status=open');
    assert.strictEqual(open.status, 200);
    assert.deepStrictEqual(open.body.items.map((t) => t.id), [1]);
    for (const item of open.body.items) assert.strictEqual(item.status, 'open');
    const combined = await get(port, '?status=open&sort=priority&order=desc&limit=1');
    assert.strictEqual(combined.status, 200);
    assert.deepStrictEqual(combined.body.items.map((t) => t.id), [1]);
  } finally {
    await stop();
  }
});

test('limit caps the page: default 20 of 21, limit=1, and limit=100 keeps all 21', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    for (let i = 0; i < 21; i++) {
      const { status } = await post(port, JSON.stringify({ title: `t${i}` }));
      assert.strictEqual(status, 201);
    }
    const defaultPage = await get(port);
    assert.strictEqual(defaultPage.status, 200);
    assert.strictEqual(defaultPage.body.items.length, 20);
    // A full page always emits the last id's cursor (base64 of 20), even though
    // one more item exists — purely count-based rule.
    assert.strictEqual(defaultPage.body.nextCursor, encodeId(20));
    const one = await get(port, '?limit=1');
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.body.items.length, 1);
    assert.strictEqual(one.body.nextCursor, encodeId(1));
    const all = await get(port, '?limit=100');
    assert.strictEqual(all.status, 200);
    assert.strictEqual(all.body.items.length, 21); // short page keeps all 21
    assert.strictEqual(all.body.nextCursor, null); // 21 < 100: end of walk
  } finally {
    await stop();
  }
});

test('invalid query parameters are 400 and leave the store and process untouched', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const first = await post(port, JSON.stringify({ title: 'one' }));
    const second = await post(port, JSON.stringify({ title: 'two' }));
    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 201);
    const rejected = [
      '?status=banana', // not a legal status
      '?status=', // present but empty: never silently applied
      '?sort=name', // unknown field
      '?sort=',
      '?order=sideways',
      '?order=',
      '?limit=0', // below the range
      '?limit=101', // above the range
      '?limit=abc', // not an integer
      '?limit=2.5',
      '?limit=-1',
      '?limit=', // present but empty
      '?cursor=@@@', // base64-impossible garbage
      '?cursor=', // present but empty: never silently page one
      '?cursor=banana', // decodes to non-id text
      '?cursor=MA==', // canonical base64, but id 0 does not exist
    ];
    for (const query of rejected) {
      const { status, body } = await get(port, query);
      assert.strictEqual(status, 400, `expected 400 for ${query}`);
      assert.ok('error' in body, `expected an "error" key, got ${JSON.stringify(body)}`);
    }
    // no restart in between: the same process still serves both todos
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
