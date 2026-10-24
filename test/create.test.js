'use strict';

// Black-box tests for POST /todos (issue #2): spawn the real server process
// and speak HTTP to it, never import internals (README "Operating model").
// Each test gets a fresh server, so allocated ids always restart at 1.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const READY_TIMEOUT_MS = 5000;

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

test('create trims the title, applies default priority, allocates id 1 with RFC3339 createdAt', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const { status, body } = await post(port, JSON.stringify({ title: '  buy milk  ' }));
    assert.strictEqual(status, 201);
    assert.strictEqual(body.id, 1);
    assert.strictEqual(body.title, 'buy milk');
    assert.strictEqual(body.priority, 3);
    assert.strictEqual(body.status, 'open');
    assert.match(body.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  } finally {
    await stop();
  }
});

test('sequential creates allocate monotonically increasing ids: 1, 2, 3', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const first = await post(port, JSON.stringify({ title: 'one' }));
    const second = await post(port, JSON.stringify({ title: 'two' }));
    const third = await post(port, JSON.stringify({ title: 'three' }));
    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 201);
    assert.strictEqual(third.status, 201);
    assert.strictEqual(first.body.id, 1);
    assert.strictEqual(second.body.id, 2);
    assert.strictEqual(third.body.id, 3);
  } finally {
    await stop();
  }
});

test('invalid titles are rejected with 400, never consume an id; 200 chars is the edge', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const invalid = [
      { title: '' }, // empty
      { title: '   ' }, // whitespace-only: empty after trim
      { title: 'a'.repeat(201), priority: 2 }, // 201 chars after trim
      { title: 42 }, // non-string
    ];
    for (const payload of invalid) {
      const { status, body } = await post(port, JSON.stringify(payload));
      assert.strictEqual(status, 400, `expected 400 for ${JSON.stringify(payload)}`);
      assert.ok('error' in body, `expected an "error" key, got ${JSON.stringify(body)}`);
    }
    const edge = await post(port, JSON.stringify({ title: 'a'.repeat(200) }));
    assert.strictEqual(edge.status, 201);
    assert.strictEqual(edge.body.id, 1); // a fresh server, and 4xx never consumed one
    assert.strictEqual(edge.body.title, 'a'.repeat(200));
  } finally {
    await stop();
  }
});

test('priority must be an integer 1..5: 0, 2.5, 6 and "3" are 400; 1 and 5 are 201', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const invalid = [0, 2.5, 6, '3'];
    for (const priority of invalid) {
      const { status, body } = await post(port, JSON.stringify({ title: 'x', priority }));
      assert.strictEqual(status, 400, `expected 400 for priority ${JSON.stringify(priority)}`);
      assert.ok('error' in body, `expected an "error" key, got ${JSON.stringify(body)}`);
    }
    const low = await post(port, JSON.stringify({ title: 'x', priority: 1 }));
    const high = await post(port, JSON.stringify({ title: 'x', priority: 5 }));
    assert.strictEqual(low.status, 201);
    assert.strictEqual(low.body.id, 1);
    assert.strictEqual(high.status, 201);
    assert.strictEqual(high.body.id, 2);
  } finally {
    await stop();
  }
});

test('malformed body is 400 and the same untouched process keeps serving /health', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const bad = await post(port, 'not json');
    assert.strictEqual(bad.status, 400);
    assert.ok('error' in bad.body, `expected an "error" key, got ${JSON.stringify(bad.body)}`);
    // no restart in between: the same process must still answer /health
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
  } finally {
    await stop();
  }
});
