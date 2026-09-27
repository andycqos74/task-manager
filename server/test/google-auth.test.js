// Sign in with Google, against a fake token endpoint.
//
// google.js and auth.js read their environment at import time, so the fake is
// started and everything configured before helpers-multi.js is imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let nextClaims = null; // what the fake token endpoint puts in the next ID token
let lastTokenRequest = null;

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    lastTokenRequest = Object.fromEntries(new URLSearchParams(raw));
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc(nextClaims)}.sig`, access_token: 'x' }));
  });
});
await new Promise((r) => fake.listen(0, r));
process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'shh';
process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${fake.address().port}/token`;
process.env.PUBLIC_URL = 'https://tasks.example.com';

const h = await import('./helpers-multi.js');
test.after(() => { h.cleanup(); fake.close(); });

const origin = h.baseUrl.replace(/\/api$/, '');

// Run the whole browser round trip. Returns the final redirect and the
// session cookie it set (if any).
async function signInWithGoogle(claims, { tamperState = false } = {}) {
  const start = await fetch(`${origin}/api/auth/google/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith('tm_oauth='));
  assert.ok(stateCookie, 'start sets the flow cookie');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://tasks.example.com/api/auth/google/callback');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');

  nextClaims = {
    iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300, nonce: to.searchParams.get('nonce'),
    email_verified: true, ...claims,
  };
  const state = tamperState ? 'forged' : to.searchParams.get('state');
  const cb = await fetch(`${origin}/api/auth/google/callback?code=abc&state=${state}`, {
    redirect: 'manual', headers: { cookie: stateCookie.split(';')[0] },
  });
  const session = cb.headers.getSetCookie().find((c) => c.startsWith('tm_session=') && !c.startsWith('tm_session=;'));
  return { location: cb.headers.get('location'), cookie: session ? session.split(';')[0] : null };
}

async function me(cookie) {
  h.useCookie(cookie);
  return h.get('/auth/me');
}

test('config advertises Google sign-in', async () => {
  assert.equal((await h.get('/auth/config')).google_enabled, true);
});

test('on a fresh instance the first Google sign-in becomes the owner', async () => {
  const r = await signInWithGoogle({ sub: 'g-owner', email: 'Owner@Example.com', name: 'Olive Owner' });
  assert.equal(r.location, '/');
  assert.ok(r.cookie);
  const user = await me(r.cookie);
  assert.equal(user.email, 'owner@example.com');
  assert.equal(user.role, 'owner');
  assert.equal(user.display_name, 'Olive Owner');
  assert.deepEqual((await h.get('/auth/identities')).map((i) => i.provider), ['google']);
  // PKCE: the verifier went to the token endpoint along with the secret.
  assert.ok(lastTokenRequest.code_verifier?.length >= 43);
  assert.equal(lastTokenRequest.client_secret, 'shh');
});

test('the same Google account signs back into the same user, even after changing its email', async () => {
  const first = await me((await signInWithGoogle({ sub: 'g-owner', email: 'owner@example.com' })).cookie);
  const again = await me((await signInWithGoogle({ sub: 'g-owner', email: 'renamed@example.com' })).cookie);
  assert.equal(again.id, first.id);
});

test('an existing password account is linked by verified email', async () => {
  h.signOutLocally();
  const created = await h.createAccount('pat@example.com', 'violet-harbour-lantern-92');
  const r = await signInWithGoogle({ sub: 'g-pat', email: 'pat@example.com' });
  assert.equal((await me(r.cookie)).id, created.user.id);
  // And the password still works.
  assert.equal((await h.loginAs('pat@example.com', 'violet-harbour-lantern-92')).user.id, created.user.id);
});

test('an unverified email is refused', async () => {
  const r = await signInWithGoogle({ sub: 'g-x', email: 'pat@example.com', email_verified: false });
  assert.equal(r.cookie, null);
  assert.match(decodeURIComponent(r.location), /auth_error=.*verified/);
});

test('a forged state, wrong audience or wrong nonce is refused', async () => {
  for (const [claims, opts] of [
    [{ sub: 'g-y', email: 'y@example.com' }, { tamperState: true }],
    [{ sub: 'g-y', email: 'y@example.com', aud: 'someone-elses-client' }, {}],
    [{ sub: 'g-y', email: 'y@example.com', nonce: 'replayed' }, {}],
    [{ sub: 'g-y', email: 'y@example.com', iss: 'https://evil.example' }, {}],
    [{ sub: 'g-y', email: 'y@example.com', exp: 1 }, {}],
  ]) {
    const r = await signInWithGoogle(claims, opts);
    assert.equal(r.cookie, null, JSON.stringify(claims));
    assert.match(r.location, /^\/\?auth_error=/);
  }
});

test('a callback without the flow cookie is refused', async () => {
  const cb = await fetch(`${origin}/api/auth/google/callback?code=abc&state=whatever`, { redirect: 'manual' });
  assert.match(cb.headers.get('location'), /auth_error=/);
  assert.ok(!cb.headers.getSetCookie().some((c) => c.startsWith('tm_session=') && !c.startsWith('tm_session=;')));
});

test('a new person gets an account only while sign-up is open', async () => {
  const open = await signInWithGoogle({ sub: 'g-new', email: 'newcomer@example.com' });
  const user = await me(open.cookie);
  assert.equal(user.role, 'user');
  // Their own, empty workspace — not the owner's.
  assert.equal((await h.get('/projects')).length, 0);

  process.env.ALLOW_REGISTRATION = 'false';
  try {
    const closed = await signInWithGoogle({ sub: 'g-stranger', email: 'stranger@example.com' });
    assert.equal(closed.cookie, null);
    assert.match(decodeURIComponent(closed.location), /no account for stranger@example\.com/);
  } finally {
    process.env.ALLOW_REGISTRATION = 'true';
  }
});

test('a Google-only account has no usable password until it sets one', async () => {
  h.signOutLocally();
  const res2 = await h.raw('POST', '/auth/login', { email: 'newcomer@example.com', password: 'anything-at-all' });
  assert.equal(res2.status, 401);
});
