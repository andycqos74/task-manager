import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, get, patch, post, raw } from './helpers.js';
import { todayISO, addDays } from '../src/dates.js';

test.after(cleanup);

const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';
const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

test('the public VAPID key is served and stable', async () => {
  const a = await get('/push/config');
  const b = await get('/push/config');
  assert.match(a.public_key, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal(a.public_key, b.public_key);
});

test('only real push services are accepted as endpoints', async () => {
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/x', // not TLS
    'https://localhost/fcm/send/x',
    'https://127.0.0.1/x',
    'https://evil.example/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example/x',
  ]) {
    const res = await raw('POST', '/push/subscribe', { subscription: { endpoint, keys } });
    assert.equal(res.status, 400, endpoint);
  }
  const bad = await raw('POST', '/push/subscribe', { subscription: { endpoint: FCM, keys: { p256dh: 'x y', auth: '' } } });
  assert.equal(bad.status, 400);
});

test('subscribe, check and unsubscribe a browser', async () => {
  assert.equal((await post('/push/status', { endpoint: FCM })).subscribed, false);
  await post('/push/subscribe', { subscription: { endpoint: FCM, keys } });
  assert.equal((await post('/push/status', { endpoint: FCM })).subscribed, true);
  await post('/push/unsubscribe', { endpoint: FCM });
  assert.equal((await post('/push/status', { endpoint: FCM })).subscribed, false);
});

test('digest settings default to the workday start and validate the time', async () => {
  const s = await get('/settings');
  assert.equal(s.digest_enabled, true);
  assert.equal(s.digest_time, s.workday_start);
  assert.equal((await raw('PATCH', '/settings', { digest_time: '25:00' })).status, 400);
  assert.equal((await patch('/settings', { digest_time: '07:30' })).digest_time, '07:30');
});

test('the digest summarises overdue, due-today and My Day tasks, once a day, inside its window', async () => {
  const { buildDigest, runDigests } = await import('../src/push.js');
  const today = todayISO();
  const me = await get('/auth/me');
  await post('/tasks', { title: 'Late one', due_date: addDays(today, -2) });
  await post('/tasks', { title: 'Due now', due_date: today });
  await post('/tasks', { title: 'Later', due_date: addDays(today, 5) });

  const digest = buildDigest(me.id, today);
  // Both dated tasks have reached their do date, so My Day counts them too.
  assert.equal(digest.title, '1 overdue · 1 due today · 2 in My Day');
  assert.equal(digest.body, '• Late one\n• Due now');

  await patch('/settings', { digest_time: '07:30' });
  await post('/push/subscribe', { subscription: { endpoint: FCM, keys } });
  const sent = [];
  const send = async (userId, payload) => { sent.push({ userId, payload }); };
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

  await runDigests(at(7, 0), send); // too early
  assert.equal(sent.length, 0);
  await runDigests(at(7, 45), send);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, me.id);
  await runDigests(at(8, 0), send); // already sent today
  assert.equal(sent.length, 1);

  // Moving the time re-arms today's digest; outside the catch-up window it stays quiet.
  await patch('/settings', { digest_time: '01:00' });
  await runDigests(at(8, 0), send);
  assert.equal(sent.length, 1);

  await patch('/settings', { digest_time: '07:30', digest_enabled: false });
  await runDigests(at(7, 45), send);
  assert.equal(sent.length, 1);
  await post('/push/unsubscribe', { endpoint: FCM });
});
