// Shared harness: a throwaway database and the real express app.
//
// db.js opens (and migrates) the database at import time, and auth.js reads
// AUTH_MODE at import time, so both have to be settled before anything imports
// them — hence the dynamic import below. Tests that need real accounts import
// helpers-multi.js, which sets the mode first and re-exports this module.
//
// The app comes from createApp(), so tests exercise the same middleware stack
// the server runs: cookie parsing, auth, scope resolution and the CSRF
// content-type check included.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-manager-test-'));
process.env.DATA_DIR = dataDir;

const { createApp, bootstrap } = await import('../src/app.js');
bootstrap();
const server = createApp({ serveClient: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

// Exposed so a test can make a raw fetch that bypasses this module's headers —
// which is exactly what checking the CSRF content-type rule requires.
export const baseUrl = base;

// The session cookie the next request will carry. Single-mode tests never
// touch it; multi-user tests swap it to act as different people.
let cookie = null;

export function cleanup() {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// Asserts success and returns the body. Use `raw` for calls expected to fail.
export async function call(method, url, body) {
  const res = await raw(method, url, body);
  assert.ok(res.ok, `${method} ${url} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

// Returns { status, ok, body } without asserting, so a test can check a refusal.
export async function raw(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    // Always sent, body or not: the server requires it on every mutating
    // request as its CSRF defence.
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  captureCookie(res);
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, ok: res.ok, body: parsed };
}

function captureCookie(res) {
  const header = res.headers.getSetCookie?.() || [];
  for (const raw of header) {
    const [pair] = raw.split(';');
    if (pair.startsWith('tm_session=')) {
      cookie = pair.endsWith('=') ? null : pair;
    }
  }
}

// ---------- acting as someone ----------

export function currentCookie() { return cookie; }
export function useCookie(value) { cookie = value; }
export function signOutLocally() { cookie = null; }

// Create the first account (which adopts anything already in the database) or
// a later one, and return { user, cookie } so a test can switch between them.
export async function createAccount(email, password, { setup = false } = {}) {
  const user = await call('POST', setup ? '/auth/setup' : '/auth/register', { email, password });
  return { user, cookie };
}

export async function loginAs(email, password) {
  cookie = null;
  const user = await call('POST', '/auth/login', { email, password });
  return { user, cookie };
}

export const get = (url) => call('GET', url);
export const post = (url, body) => call('POST', url, body);
export const patch = (url, body) => call('PATCH', url, body);
export const put = (url, body) => call('PUT', url, body);
export const del = (url) => call('DELETE', url);
