'use strict';

// Black-box tests for PATCH and DELETE /todos/<id> (issue #3): spawn the real
// server process and speak HTTP to it, never import internals (README
// "Operating model"). Each test gets a fresh server, so allocated ids always
// restart at 1.

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

async function patch(port, id, body) {
  const res = await fetch(`http://127.0.0.1:${port}/todos/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined; // callers assert on status/text, not on body shape
  }
  return { status: res.status, body: parsed, text };
}

async function del(port, id) {
  const res = await fetch(`http://127.0.0.1:${port}/todos/${id}`, { method: 'DELETE' });
  // 204 carries an empty body: read text, never res.json().
  return { status: res.status, text: await res.text() };
}

test('PATCH transitions open->done and back, preserving every other field', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const created = await post(port, JSON.stringify({ title: 'buy milk', priority: 2 }));
    assert.strictEqual(created.status, 201);
    const done = await patch(port, 1, JSON.stringify({ status: 'done' }));
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.body.status, 'done');
    // every field of the stored todo must still be present
    assert.strictEqual(done.body.id, 1);
    assert.strictEqual(done.body.title, 'buy milk');
    assert.strictEqual(done.body.priority, 2);
    assert.strictEqual(done.body.createdAt, created.body.createdAt);
    const reopened = await patch(port, 1, JSON.stringify({ status: 'open' }));
    assert.strictEqual(reopened.status, 200);
    assert.strictEqual(reopened.body.status, 'open');
    // the second transition answering 200 also proves the first one persisted
    assert.strictEqual(reopened.body.id, 1);
    assert.strictEqual(reopened.body.title, 'buy milk');
    assert.strictEqual(reopened.body.priority, 2);
    assert.strictEqual(reopened.body.createdAt, created.body.createdAt);
  } finally {
    await stop();
  }
});

test('PATCH on an unknown id is 404 with an error', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const { status, body } = await patch(port, 999, JSON.stringify({ status: 'done' }));
    assert.strictEqual(status, 404);
    assert.ok('error' in body, `expected an "error" key, got ${JSON.stringify(body)}`);
  } finally {
    await stop();
  }
});

test('PATCH rejects invalid bodies with 400 and the todo survives every rejection', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const created = await post(port, JSON.stringify({ title: 'buy milk', priority: 2 }));
    assert.strictEqual(created.status, 201);
    const rejected = [
      JSON.stringify({ status: 'banana' }), // not a legal status
      JSON.stringify({ status: 'Done' }), // case-sensitive: 400
      JSON.stringify({ status: 'open', priority: 2 }), // extra field
      JSON.stringify({ status: 'done', title: 'x' }), // extra field
      JSON.stringify({}), // missing status
      JSON.stringify({ status: 1 }), // non-string status
      '"x"', // valid JSON, not an object
      'not json', // malformed
    ];
    for (const payload of rejected) {
      const { status, body } = await patch(port, 1, payload);
      assert.strictEqual(status, 400, `expected 400 for ${payload}`);
      assert.ok('error' in body, `expected an "error" key, got ${JSON.stringify(body)}`);
    }
    // Body-first ordering, which the issue leaves unspecified and pinned here
    // as deliberate: an invalid body is 400 even toward an unknown id.
    const unknown = await patch(port, 999, JSON.stringify({ status: 'banana' }));
    assert.strictEqual(unknown.status, 400);
    assert.ok('error' in unknown.body);
    // no restart in between: every rejection above left the todo untouched
    const done = await patch(port, 1, JSON.stringify({ status: 'done' }));
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.body.status, 'done');
    assert.strictEqual(done.body.title, 'buy milk');
  } finally {
    await stop();
  }
});

test('DELETE returns 204 with an empty body; the id then vanishes for every verb', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const created = await post(port, JSON.stringify({ title: 'buy milk' }));
    assert.strictEqual(created.status, 201);
    const gone = await del(port, 1);
    assert.strictEqual(gone.status, 204);
    assert.strictEqual(gone.text, '');
    // repeating the delete: the id is already gone
    assert.strictEqual((await del(port, 1)).status, 404);
    // patching the deleted id: 404, not a resurrected todo
    const patched = await patch(port, 1, JSON.stringify({ status: 'done' }));
    assert.strictEqual(patched.status, 404);
    assert.ok('error' in patched.body);
    // unknown id was never there either
    assert.strictEqual((await del(port, 999)).status, 404);
    // no restart in between: the same process still serves /health
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
  } finally {
    await stop();
  }
});

test('deleted ids are never allocated again: delete 2, then create gets id 4', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    for (const title of ['one', 'two', 'three']) {
      const { status } = await post(port, JSON.stringify({ title }));
      assert.strictEqual(status, 201);
    }
    assert.strictEqual((await del(port, 2)).status, 204);
    const fourth = await post(port, JSON.stringify({ title: 'four' }));
    assert.strictEqual(fourth.status, 201);
    assert.strictEqual(fourth.body.id, 4);
  } finally {
    await stop();
  }
});
