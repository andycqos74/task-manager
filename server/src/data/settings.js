// Per-user settings: workday hours, the Anthropic API key, the active
// workspace. Each user's are their own — one person's key is never visible to
// or spendable by another.
//
// The old global `settings` table is left in place but no longer read: its
// rows were copied into the first account by adoptOrphanData() so an in-place
// upgrade keeps its key and workday settings.
import { db } from '../db.js';

export function getSettings(scope) {
  const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(scope.userId);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  out.workday_minutes = parseInt(out.workday_minutes, 10) || 480;
  out.workday_start = out.workday_start || '09:00';
  return out;
}

export function setSetting(scope, key, value) {
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?,?,?)
              ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`)
    .run(scope.userId, key, String(value));
}

export function deleteSetting(scope, key) {
  db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(scope.userId, key);
}
