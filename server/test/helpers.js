// Shared harness: a throwaway database and the real express app.
//
// db.js opens (and migrates) the database at import time, so DATA_DIR has to
// be set before anything imports it — hence the dynamic import below. The app
// comes from createApp(), so tests exercise the same middleware stack the
// server runs, scope resolution included.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-manager-test-'));
process.env.DATA_DIR = dataDir;

const { createApp } = await import('../src/app.js');
const server = createApp({ serveClient: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

export function cleanup() {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// Asserts success and returns the body. Use `raw` for the calls that are
// expected to fail.
export async function call(method, url, body) {
  const res = await raw(method, url, body);
  assert.ok(res.ok, `${method} ${url} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

// Returns { status, ok, body } without asserting, so a test can check for a
// refusal.
export async function raw(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, ok: res.ok, body: parsed };
}

export const get = (url) => call('GET', url);
export const post = (url, body) => call('POST', url, body);
export const patch = (url, body) => call('PATCH', url, body);
export const put = (url, body) => call('PUT', url, body);
export const del = (url) => call('DELETE', url);
