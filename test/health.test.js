'use strict';

// Black-box tests: spawn the real server process and speak HTTP to it,
// never import internals (README "Operating model").

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

test('GET /health returns 200 {"ok":true}', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.status, 200);
  } finally {
    await stop();
  }
});

test('GET /nope returns 404 with an error body', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.ok('error' in body, `expected an "error" key, got ${JSON.stringify(body)}`);
  } finally {
    await stop();
  }
});

test('POST /todos with malformed JSON returns 400 and /health survives', async () => {
  const { ready, stop } = startServer();
  try {
    const port = await ready;
    const bad = await fetch(`http://127.0.0.1:${port}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"title":', // never a 500, never a hang (PRD §Errors)
    });
    assert.strictEqual(bad.status, 400);
    const badBody = await bad.json();
    assert.ok('error' in badBody, `expected an "error" key, got ${JSON.stringify(badBody)}`);
    // the same process must keep serving /health immediately after the abuse
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
  } finally {
    await stop();
  }
});
