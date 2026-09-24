// Web Push: VAPID keys, delivery, and the daily digest.
//
// The digest is the only scheduled notification. Tasks carry dates, not
// times, so a per-task "reminder at 14:00" has nothing to hang off; instead
// each subscribed user gets one morning summary of what is overdue, due today
// and in My Day, at their own digest time (default: their workday start).
// Dates follow the server's local timezone, like the rest of the app.
import webpush from 'web-push';
import { getAppSetting, setAppSetting } from './db.js';
import { todayISO } from './dates.js';
import { getSettings, setSetting } from './data/settings.js';
import * as Push from './data/push.js';
import * as Workspaces from './data/workspaces.js';
import * as Tasks from './data/tasks.js';

// The push service needs a contact for the sender. Overridable because a
// public instance should give its own.
const DEFAULT_SUBJECT = 'https://github.com/andycqos74/task-manager';

// Only send a missed digest if the server comes up within this long after the
// digest time; otherwise a restart at 8pm would deliver a "good morning".
const CATCH_UP_MINUTES = 180;

let configured = null;

// Keys come from the environment if set, otherwise are generated once and
// kept in app_settings. They must stay stable: rotating them invalidates every
// existing subscription.
export function vapidKeys() {
  if (configured) return configured;
  let publicKey = process.env.VAPID_PUBLIC_KEY;
  let privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    publicKey = getAppSetting('vapid_public_key');
    privateKey = getAppSetting('vapid_private_key');
    if (!publicKey || !privateKey) {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      setAppSetting('vapid_public_key', publicKey);
      setAppSetting('vapid_private_key', privateKey);
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || DEFAULT_SUBJECT, publicKey, privateKey);
  configured = { publicKey, privateKey };
  return configured;
}

// Deliver to every browser the user has subscribed. Endpoints the push service
// says are gone are dropped; other failures are logged and skipped so one bad
// browser cannot block the rest.
export async function sendToUser(userId, payload) {
  vapidKeys();
  const body = JSON.stringify(payload);
  let sent = 0;
  for (const sub of Push.listSubscriptions(userId)) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 6 * 60 * 60 },
      );
      sent += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) Push.forgetEndpoint(sub.endpoint);
      else console.warn(`push to user ${userId} failed: ${err.statusCode || ''} ${err.message}`);
    }
  }
  return sent;
}

// What the morning notification says, across all of the user's workspaces.
// Returns null when there is nothing worth interrupting anyone for.
export function buildDigest(userId, today = todayISO()) {
  const overdue = [];
  const dueToday = [];
  let myDay = 0;
  for (const ws of Workspaces.listWorkspaces({ userId })) {
    for (const t of Tasks.listOpenTasks({ userId, workspaceId: ws.id })) {
      if (t.due_date && t.due_date < today) overdue.push(t);
      else if (t.due_date === today) dueToday.push(t);
      if (t.in_my_day) myDay += 1;
    }
  }
  if (!overdue.length && !dueToday.length && !myDay) return null;

  const parts = [];
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  if (dueToday.length) parts.push(`${dueToday.length} due today`);
  if (myDay) parts.push(`${myDay} in My Day`);
  const highlights = [...overdue, ...dueToday].slice(0, 3).map((t) => `• ${t.title}`);
  return {
    title: parts.join(' · '),
    body: highlights.length ? highlights.join('\n') : 'Open My Day to plan it.',
    tag: `digest-${today}`,
    url: '/',
  };
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function digestTime(settings) {
  return settings.digest_time || settings.workday_start || '09:00';
}

// One scheduler tick. The last-sent date is recorded before sending so a slow
// or failing push service can never produce a second digest the same day.
// `send` is swappable so tests can observe deliveries without a push service.
export async function runDigests(now = new Date(), send = sendToUser) {
  const today = todayISO(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const userId of Push.usersWithSubscriptions()) {
    const scope = { userId };
    const settings = getSettings(scope);
    if (settings.digest_enabled === '0' || settings.digest_last_sent === today) continue;
    const at = minutesOf(digestTime(settings));
    if (at === null || nowMinutes < at || nowMinutes >= at + CATCH_UP_MINUTES) continue;
    setSetting(scope, 'digest_last_sent', today);
    const digest = buildDigest(userId, today);
    if (digest) await send(userId, digest);
  }
}

export function startDigestScheduler() {
  const tick = () => runDigests().catch((err) => console.error('digest run failed', err));
  const timer = setInterval(tick, 60 * 1000);
  timer.unref?.();
  tick();
}
