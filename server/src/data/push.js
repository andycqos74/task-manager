// Web Push subscriptions. Not workspace-scoped: a subscription belongs to a
// person (and one browser), and the digest it receives covers all of that
// person's workspaces. Every query names the user explicitly.
import { db } from '../db.js';

// Upsert on the endpoint. If the same browser was subscribed under another
// account (a shared device that changed hands), it moves to the caller: only
// the browser holding the endpoint can have sent it to us.
export function saveSubscription(userId, { endpoint, p256dh, auth, userAgent }) {
  db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET
                user_id = excluded.user_id, p256dh = excluded.p256dh,
                auth = excluded.auth, user_agent = excluded.user_agent`)
    .run(endpoint, userId, p256dh, auth, userAgent || null);
}

export function deleteSubscription(userId, endpoint) {
  return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId).changes;
}

// Called when the push service reports the endpoint gone (404/410).
export function forgetEndpoint(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function listSubscriptions(userId) {
  return db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
}

export function hasSubscription(userId, endpoint) {
  return !!db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(endpoint, userId);
}

// Active users with at least one subscribed browser — the digest candidates.
export function usersWithSubscriptions() {
  return db.prepare(`SELECT DISTINCT p.user_id AS id FROM push_subscriptions p
                     JOIN users u ON u.id = p.user_id WHERE u.is_active = 1`).all().map((r) => r.id);
}
