'use strict';

// Adversarial survival battery (issue #6, PRD §Errors): fire every class of
// bad request — malformed bodies, invalid query parameters, unknown paths,
// wrong methods, oversized bodies — at ONE server instance and assert it
// answers each with a JSON error and keeps serving /health immediately
// after. Black-box: spawn the real server process and speak HTTP to it,
// never import internals (README "Operating model"). A crash must fail the
// test runner's assertions, not kill the runner itself, so the server is a
// child process and every scenario double-checks /health on the same
// instance before moving on. node:test runs same-file tests sequentially,
// so the single shared instance is deterministic.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { test, before, after } = require('node:test');
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

// One shared instance for the whole battery: restarting between scenarios
// would mask exactly the crash-on-bad-request this issue forbids.
let port;
let stop;

before(async () => {
  const server = startServer();
  stop = server.stop;
  port = await server.ready;
});

after(async () => {
  await stop?.();
});

// Tolerant-parse response helper: returns { status, text, body } where body
// is the parsed JSON or undefined — a non-JSON answer must surface as a
// status/text assertion failure, never as an unhandled throw here.
async function requestJson(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text };
}

// The property the whole issue is about: after EVERY bad request the same
// untouched process still answers GET /health with 200 {"ok":true}.
async function expectSurvive() {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true });
}

test('unknown path is 404 with an error body and /health still answers {"ok":true}', async () => {
  const { status, body } = await requestJson('GET', '/definitely/not/here');
  assert.strictEqual(status, 404);
  assert.ok('error' in body, `expected an "error" key, got ${JSON.stringify(body)}`);
  await expectSurvive();
});

test('truncated JSON then garbage body are 400 and /health stays up', async () => {
  const truncated = await requestJson('POST', '/todos', '{"title":');
  assert.strictEqual(truncated.status, 400);
  assert.ok('error' in truncated.body, `expected an "error" key, got ${truncated.text}`);
  // Validation precedes the id lookup in handlePatch, so this is 400 even
  // though the store is empty and id 1 does not exist.
  const garbage = await requestJson('PATCH', '/todos/1', 'zzz');
  assert.strictEqual(garbage.status, 400);
  assert.ok('error' in garbage.body, `expected an "error" key, got ${garbage.text}`);
  await expectSurvive();
});

test('PUT /todos answers with an error body, never a connection error', async () => {
  // The issue accepts 404 or 405 for collection endpoints with wrong
  // methods; what it forbids is a reset socket or a crash. fetch throwing
  // (ECONNRESET) fails this test by itself.
  const { status, body } = await requestJson('PUT', '/todos', '{}');
  assert.ok(status === 404 || status === 405, `expected 404 or 405, got ${status}`);
  assert.ok('error' in body, `expected an "error" key, got ${JSON.stringify(body)}`);
  await expectSurvive();
});

test('ten consecutive invalid requests all get error answers and /health stays up', async () => {
  const battery = [
    // [method, path, body, acceptable statuses]
    ['POST', '/todos', '{"title":', [400]], // truncated JSON
    ['PATCH', '/todos/1', 'zzz', [400]], // garbage body
    ['GET', '/definitely/not/here', undefined, [404]], // unknown path
    ['PUT', '/todos', '{}', [404, 405]], // wrong method on a collection
    ['GET', '/todos?limit=0', undefined, [400]], // limit below range
    ['GET', '/todos?order=sideways', undefined, [400]], // unknown order
    ['GET', '/todos?cursor=@@@', undefined, [400]], // base64-impossible cursor
    ['POST', '/todos', 'null', [400]], // valid JSON, but null is not an object
    ['DELETE', '/todos/999999', undefined, [404]], // unknown but well-formed id
    ['GET', '/todos/abc', undefined, [404]], // non-numeric id matches no route
  ];
  for (const [method, path, body, acceptable] of battery) {
    const { status, body: parsed, text } = await requestJson(method, path, body);
    assert.ok(
      acceptable.includes(status),
      `expected ${acceptable.join(' or ')} for ${method} ${path}, got ${status} (${text})`,
    );
    assert.ok(
      parsed !== undefined && 'error' in parsed,
      `expected a JSON "error" body for ${method} ${path}, got ${text}`,
    );
  }
  await expectSurvive();
});

test('a 1 MiB-plus body is 400 payload too large and /health stays up', async () => {
  // The readBody cap stops storing at MAX_BODY_BYTES but keeps draining, so
  // the process must answer 400 rather than choke or die on a hostile
  // upload — the one survival path no other test file exercises.
  const oversized = 'x'.repeat(1024 * 1024 + 512 * 1024);
  const { status, body } = await requestJson('POST', '/todos', JSON.stringify({ title: oversized }));
  assert.strictEqual(status, 400);
  assert.ok('error' in body, `expected an "error" key, got ${JSON.stringify(body)}`);
  await expectSurvive();
});
