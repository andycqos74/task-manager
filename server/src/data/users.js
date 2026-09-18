// Accounts and sessions.
//
// These are the only accessors that are not scoped to a user — they are how a
// user is established in the first place. Everything else in src/data/ takes a
// scope.
import { db } from '../db.js';

export function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function findByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normaliseEmail(email)) || null;
}

export function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

// The implicit owner in single mode, and the account that adopted any
// pre-accounts data in multi mode.
export function firstUser() {
  return db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get() || null;
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

export function createUser({ email, passwordHash, displayName = '', role = 'user' }) {
  const id = db
    .prepare('INSERT INTO users (email, password_hash, display_name, role, password_changed_at) VALUES (?,?,?,?,datetime(\'now\'))')
    .run(normaliseEmail(email), passwordHash, displayName, role).lastInsertRowid;
  return getUser(id);
}

export function setPassword(userId, passwordHash) {
  db.prepare(`UPDATE users SET password_hash = ?, password_changed_at = datetime('now'),
              updated_at = datetime('now') WHERE id = ?`)
    .run(passwordHash, userId);
}

export function setDisplayName(userId, displayName) {
  db.prepare(`UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?`).run(displayName, userId);
}

// ---------- login throttling ----------

export function recordLoginFailure(userId, { lockAfter, lockSeconds }) {
  const failures = db.prepare('SELECT failed_logins FROM users WHERE id = ?').get(userId).failed_logins + 1;
  // Each lockout past the threshold doubles, capped at an hour, so a
  // determined guesser slows down fast while a fat-fingered owner does not get
  // shut out for long.
  const over = failures - lockAfter;
  const seconds = over >= 0 ? Math.min(lockSeconds * 2 ** over, 3600) : null;
  db.prepare(`UPDATE users SET failed_logins = ?,
              locked_until = CASE WHEN ? IS NULL THEN locked_until ELSE datetime('now', ? || ' seconds') END,
              updated_at = datetime('now') WHERE id = ?`)
    .run(failures, seconds, seconds == null ? null : `+${seconds}`, userId);
}

export function clearLoginFailures(userId) {
  db.prepare(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now'),
              updated_at = datetime('now') WHERE id = ?`).run(userId);
}

export function lockedUntil(user) {
  if (!user.locked_until) return null;
  const row = db.prepare(`SELECT datetime('now') < ? AS locked`).get(user.locked_until);
  return row.locked ? user.locked_until : null;
}

// ---------- sessions ----------

export function createSession({ tokenHash, userId, ttlSeconds, userAgent, ip }) {
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip)
              VALUES (?,?, datetime('now', ? || ' seconds'), ?, ?)`)
    .run(tokenHash, userId, `+${ttlSeconds}`, (userAgent || '').slice(0, 300), (ip || '').slice(0, 64));
}

// Returns the session joined to its user, or null when it is missing, expired
// or belongs to a deactivated account.
export function sessionByHash(tokenHash) {
  return db
    .prepare(`SELECT s.*, u.id AS uid FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.is_active = 1`)
    .get(tokenHash) || null;
}

// Sliding expiry, bumped at most once an hour so a busy session does not write
// on every request.
export function touchSession(tokenHash, ttlSeconds) {
  db.prepare(`UPDATE sessions SET last_seen_at = datetime('now'),
              expires_at = datetime('now', ? || ' seconds')
              WHERE token_hash = ? AND last_seen_at < datetime('now', '-1 hours')`)
    .run(`+${ttlSeconds}`, tokenHash);
}

export function deleteSession(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

// Used when a password changes: every other device is signed out.
export function deleteUserSessions(userId, { except = null } = {}) {
  if (except) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, except);
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function listSessions(userId) {
  return db
    .prepare(`SELECT token_hash, created_at, last_seen_at, expires_at, user_agent, ip
              FROM sessions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY last_seen_at DESC`)
    .all(userId);
}

export function purgeExpiredSessions() {
  return db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run().changes;
}
