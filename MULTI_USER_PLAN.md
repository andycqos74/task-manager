# Plan: multiple user accounts

Design for turning the app from a single-tenant tool into one that hosts several
independent users, each with their own workspaces, projects, tasks, notes, boards,
settings and API keys, visible to nobody else.

Nothing is shared between users. There is no team, no sharing, no admin view of other
people's content — those are explicit non-goals.

Read `BRANCHING.md` first: this is implemented in **this** codebase, with `AUTH_MODE=single`
preserving today's login-free behaviour, rather than in a fork.

---

## 1. Where the app is today

| Area | Today | Implication |
|---|---|---|
| Identity | none — the API is open to anyone who can reach the port | everything below is new |
| Top-level scope | `workspaces`, with `workspace_id` on projects/tasks/notes/ideas/boards | good news: the ownership column has a natural home one level up |
| Active scope | ~~`activeWorkspaceId()` reads a **global** row in `settings` (26 call sites)~~ — **done in phase 0**: resolved once per request into `req.scope` | the value is still global; phase 1 moves it into the signed-in user's settings |
| Settings | one global `settings` key/value table, including `anthropic_api_key` | must become per-user |
| Fetch by id | ~~looked rows up by primary key with **no scope filter**~~ — **done in phase 0**: every accessor filters on the scope, and a test proves it | phase 1 adds `AND user_id = ?` in the same accessors |
| Transport | plain HTTP on :3001, `app.use(cors())` allows every origin | both must change before accounts exist |
| Endpoints | 63 in `server/src/routes.js` | **done in phase 0**: each goes through a scoped accessor, asserted by `test/isolation.test.js` |

**The central piece of work is not the login screen — it is making every query provably
scoped to the caller.** Budget accordingly.

---

## 2. Data model

New tables:

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,              -- stored lowercased/trimmed
  password_hash TEXT NOT NULL,             -- scrypt$N$r$p$salt$hash (§4.1)
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner','user')),
  is_active INTEGER NOT NULL DEFAULT 1,
  -- brute-force throttling
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  -- MFA, phase 3. Columns added now so the table shape never changes again.
  totp_secret_enc TEXT,                    -- AES-256-GCM (§6)
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  recovery_codes_enc TEXT,                 -- encrypted JSON array of hashes
  password_changed_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Opaque server-side sessions. The cookie carries a random token; only its
-- SHA-256 is stored, so a stolen database does not yield usable sessions.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Per-user replacement for the current global settings table.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Instance-wide configuration that is not a user's business
-- (registration open/closed, schema version, invite tokens).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Ownership on existing tables:

```sql
ALTER TABLE workspaces ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
```

`workspaces.user_id` is the **single source of truth** for ownership — everything else
already hangs off a workspace.

Also stamp `user_id` on the direct children (`projects`, `tasks`, `notes`, `ideas`,
`boards`) as a denormalised copy. It is redundant by design: it means a filter can be
written without a join, so the cheap query is also the safe one, and a forgotten join
cannot leak rows. Keep them consistent with triggers or with a single insert helper —
never by hand at each call site.

```sql
CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
-- ...and one per stamped table
```

Grandchildren (`subtasks`, `task_dependencies`, `epics`, `user_stories`, `board_columns`)
stay unstamped and are reached only through a parent that has already been ownership-checked
(§5).

**One exception needs deliberate handling: the scratch note.** It is a single global row
(`notes.is_scratch = 1`, `workspace_id` NULL) shared by every workspace on purpose, and
phase 0 preserved that. Shared between *workspaces* is a feature; shared between *users* is
a data leak, so phase 1 must give it a `user_id` (or hold its id in each user's settings)
at the same time as the rest of the ownership work. `server/src/data/notes.js` carries a
comment saying so.

---

## 3. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_MODE` | `single` | `single` = auto-login as user #1, no login screen (today's behaviour). `multi` = real accounts. |
| `ALLOW_REGISTRATION` | `false` | `true` = open sign-up; `invite` = requires a token; `false` = owner creates accounts. |
| `SESSION_SECRET` | — | required in `multi`; rotating it logs everyone out. |
| `APP_ENCRYPTION_KEY` | — | base64 32 bytes; required in `multi` (§6). |
| `APP_ENCRYPTION_KEY_OLD` | — | previous key, accepted for decrypt during rotation. |
| `SESSION_TTL_DAYS` | `30` | sliding expiry. |
| `TRUST_PROXY` | `false` | set when behind a reverse proxy, so `Secure` cookies and client IPs work. |
| `BOOTSTRAP_ADMIN_EMAIL` | — | optional; otherwise first run shows a setup screen. |

Defaulting `AUTH_MODE` to `single` is what makes the personal stack a no-op upgrade.

---

## 4. Authentication

### 4.1 Passwords

Use `node:crypto`'s **scrypt** — no new dependency, no extra native compile, and it is a
memory-hard KDF that is appropriate here:

```js
// N=2^15, r=8, p=1, 32-byte salt, 64-byte output → ~100ms per hash
const stored = `scrypt$32768$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
```

Compare with `crypto.timingSafeEqual`. Parse the parameters out of the stored string so
they can be raised later without invalidating existing hashes. (Argon2id via
`@node-rs/argon2` is marginally stronger if a dependency is acceptable; scrypt at these
parameters is fine for this threat model.)

Rules: minimum 12 characters, maximum 200 (bound the hashing work), check against a small
list of obvious passwords, never log or echo them.

### 4.2 Sessions

Opaque server-side sessions in the `sessions` table, not JWTs — they are revocable, need no
refresh dance, and "log out everywhere" is one `DELETE`.

- Token: 32 random bytes, base64url. Stored as SHA-256; the raw value only exists in the
  cookie.
- Cookie: `tm_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` whenever
  `TRUST_PROXY` is set or `NODE_ENV=production`, `Max-Age` from `SESSION_TTL_DAYS`.
- Sliding expiry: bump `last_seen_at`/`expires_at` at most once per hour, not per request.
- Issue a **new** token on login and on password change; delete all of a user's sessions
  when their password changes.
- Sweep expired rows on start and hourly.

### 4.3 CSRF

`SameSite=Lax` blocks the common cross-site form post, but do not rely on it alone. On every
mutating request require:

1. `Content-Type: application/json` (an HTML form cannot send it cross-origin), and
2. a double-submit token: a non-`HttpOnly` `tm_csrf` cookie echoed in an `X-TM-CSRF`
   header, compared with `timingSafeEqual`.

The client wrapper in `client/src/api.js` adds the header in one place.

### 4.4 Rate limiting and lockout

Per email and per IP, in SQLite (no new dependency): after 5 failures inside 15 minutes set
`locked_until = now + 15 min`, doubling up to an hour. Return the same generic
`invalid email or password` for unknown email, wrong password and locked account, and take
a constant-ish time in each case so the response does not reveal which. Log failures with
IP and timestamp.

### 4.5 Endpoints

```
POST   /api/auth/register      email, password, (invite token)   -> 201 + session
POST   /api/auth/login         email, password, (totp)           -> 200 + session cookie
POST   /api/auth/logout        current session                   -> 204
GET    /api/auth/me            -> { id, email, display_name, totp_enabled }
POST   /api/auth/password      current + new password            -> 204, revokes sessions
GET    /api/auth/sessions      list of active sessions
DELETE /api/auth/sessions/:id  revoke one
POST   /api/setup              first-run owner creation (only while no users exist)
```

MFA additions in phase 3: `POST /api/auth/mfa/setup` (returns a provisioning URI and QR),
`/mfa/confirm`, `/mfa/disable`, `/mfa/recovery-codes`.

### 4.6 Transport

Cookie sessions over plain HTTP are readable by anyone on the network path. **Multi-user
mode requires TLS.** Put the container behind Caddy, nginx or Traefik, set `TRUST_PROXY=1`,
and have the server refuse to start in `AUTH_MODE=multi` without either TLS termination
declared or an explicit `ALLOW_INSECURE=1`. Also drop `app.use(cors())` in
`server/index.js` — the UI is same-origin, so the open CORS policy has no purpose and
becomes a liability once credentials exist.

---

## 5. Scoping every query — the core work

**Status: built (phase 0).** This is where a multi-user app is won or lost, so it was done
structurally rather than by remembering to add a `WHERE` clause 63 times. What follows
describes what is in the tree and what phase 1 adds to it.

### 5.1 A scope object, not a bare id — **done**

`server/src/scope.js` resolves one scope per request in `server/src/app.js`, before any
handler runs:

```js
app.use('/api', attachScope, router);   // req.scope = { workspaceId }
```

The 26 global `activeWorkspaceId()` call sites are gone. Phase 1 adds `userId` to that
object, sourced from the session, and takes `workspaceId` from the user's own
`active_workspace_id` in `user_settings` — which is what ends the last-writer-wins race
between two people using one server.

### 5.2 Auth middleware — phase 1

```js
// server/src/auth.js
app.use(attachUser);     // reads the cookie, loads the session, sets req.user
router.use(requireUser); // 401 if absent; in AUTH_MODE=single, attachUser
                         // always sets user #1 so this is a no-op
```

`attachScope` then reads `req.user` instead of the global setting. Nothing in
`routes.js` changes.

### 5.3 Ownership-checked accessors — **done**

All SQL now lives in `server/src/data/` (`tasks.js`, `projects.js`, `notes.js`, `dev.js`,
`ideas.js`, `boards.js`, `workspaces.js`). Every accessor takes the scope and filters on
it, and the unscoped helpers are gone, so there is no unsafe version left to call by
accident:

```js
// before, in routes.js
function getTask(id) {
  return db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
}

// now, in data/tasks.js
export function getTask(scope, id) {
  return db.prepare(`${TASK_SELECT} WHERE t.id = ? AND t.workspace_id = ?`)
           .get(id, scope.workspaceId);   // phase 1 adds AND t.user_id = ?
}
```

Two accessors per entity, deliberately: `getTask(scope, id)` for the active workspace, and
`getTaskAnywhere(scope, id)` for the move endpoints, whose destination is by definition
another workspace. Keeping that distinction explicit means phase 1 adds an owner filter to
the second rather than having to work out, query by query, which reach was meant. Each
module also carries an `UPDATABLE` column allowlist, so a stray key in a request body
cannot become part of an `UPDATE`.

For grandchildren, resolve through the parent and check the parent:

```js
function getStory(id, scope) {
  return db.prepare(`SELECT s.* FROM user_stories s
                     JOIN epics e ON e.id = s.epic_id
                     JOIN projects p ON p.id = e.project_id
                     WHERE s.id = ? AND p.user_id = ?`).get(id, scope.userId);
}
```

Return **404, not 403**, for a row owned by someone else — 403 confirms the row exists.

### 5.4 Prove it, don't hope — **done**

`server/test/isolation.test.js` seeds two workspaces with identical fixtures and, with A
active:

1. calls all 32 endpoints that take an id in the path with B's ids, asserting `404`;
2. calls the 16 that take an id in a request body with B's ids, asserting `400`;
3. asserts every list endpoint returns only A's rows;
4. re-activates B and asserts its fixtures are untouched — so a refusal that nevertheless
   wrote something is caught too;
5. asserts `routes.js` contains no SQL of its own, so a new endpoint has to go through the
   scoped accessors.

It returns **404, not 403**, for a row owned by someone else: 403 confirms the row exists.

The suite was verified by regression — reverting one accessor to its unscoped form makes it
fail. `server/src/app.js` exports `createApp()` so the tests drive the real middleware
stack rather than a partial copy of it.

Phase 1 runs the same table a second time with two users instead of two workspaces, which
is why it is written as a table rather than as prose.

---

## 6. Encryption

Three separable things, worth doing in this order:

### 6.1 Field-level encryption of secrets — do this

AES-256-GCM over the values that are genuinely sensitive: Anthropic API keys, TOTP secrets,
recovery codes.

```js
// server/src/crypto.js
// format: v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
encryptField(plaintext, aad)   // aad = `${table}:${column}:${userId}`
decryptField(stored, aad)
```

- Key from `APP_ENCRYPTION_KEY` (base64 32 bytes). Generate with
  `openssl rand -base64 32`.
- The AAD binds each ciphertext to its row, so a copied value cannot be moved to another
  user's record and decrypted there.
- Rotation: accept `APP_ENCRYPTION_KEY_OLD` for decryption, re-encrypt with the current key
  on next write, plus a one-shot re-encrypt-all script.
- Refuse to start in `AUTH_MODE=multi` without the key rather than silently storing
  plaintext.

**Email stays plaintext.** Encrypting it breaks the uniqueness constraint and login lookup;
the workaround (a blind index — HMAC of the lowercased address with a pepper, unique-indexed
— plus a separate encrypted copy for display) is real but not worth the complexity here.

### 6.2 Whole-database encryption at rest — cheap, worth it

Swap `better-sqlite3` for `better-sqlite3-multiple-ciphers` (a drop-in fork bundling
SQLCipher) and key it on open:

```js
const db = new Database(file);
db.pragma(`key = '${process.env.DB_ENCRYPTION_KEY}'`);  // before any other statement
db.pragma('journal_mode = WAL');
```

The Dockerfile already has the toolchain stage the native build needs, so this is a
package swap plus two lines. Migrating an existing plaintext database uses
`sqlcipher_export()` — script it, and **back up before running it**.

Be clear about what this buys: it protects a stolen volume, a stolen backup tarball or a
decommissioned disk. It does **not** protect a running server — the process holds the key,
so anyone with host access can read the data. Losing `DB_ENCRYPTION_KEY` means losing the
database; store it somewhere other than the server it protects.

### 6.3 Per-user envelope encryption of content — recommended against

Encrypting note and task bodies with a key derived from each user's password would mean:

- no server-side search or filtering (every query would have to decrypt everything)
- the AI features stop working — `server/src/ai.js` has to send plaintext to the API anyway
- a forgotten password destroys the data permanently, with no reset possible

The confidentiality gain over 6.1 + 6.2 is small for this threat model. Skip it. If it is
ever wanted, it belongs in a client-side-encryption redesign, not bolted onto this one.

### 6.4 What actually keeps users apart

Encryption is not the isolation mechanism — §5 is. A missing `WHERE user_id = ?` leaks
plaintext through the API no matter how the bytes are stored on disk. Encryption protects
data at rest; query scoping protects data in use. Do both, and do not let the first create
false confidence about the second.

---

## 7. Client changes

- **Auth context** (`client/src/AuthContext.jsx`): loads `/api/auth/me` on boot; renders the
  login screen when it 401s, the app when it succeeds. In `AUTH_MODE=single` the endpoint
  always succeeds, so nothing changes visually.
- **`client/src/api.js`**: add the `X-TM-CSRF` header, and on a 401 clear the auth state and
  bounce to login instead of throwing into each view. `fetch` already sends same-origin
  cookies by default, so no other change is needed.
- **New views**: `Login.jsx`, `Register.jsx` (when enabled), `Setup.jsx` (first run),
  `Account.jsx` (display name, change password, active sessions, later MFA).
- **`Settings.jsx`**: the Claude API key and workday settings become per-user — the UI does
  not change, only what the endpoint reads and writes.
- **Header**: an account menu with the signed-in email and a sign-out item.

---

## 8. Migration and first run

For an existing database, on first start with the new code:

1. Create the tables above; `users` is empty.
2. **`AUTH_MODE=single`**: create user #1 (`owner`, a placeholder email, an unusable
   password hash), assign all existing rows to it, copy the global `settings` rows into
   `user_settings` for user #1, and move instance keys into `app_settings`. Nobody sees a
   login screen. This path must be exercised by the existing test suite.
3. **`AUTH_MODE=multi`** with no users: serve a first-run **setup screen** that creates the
   owner account, then adopt all existing rows into it — same as above but with a real email
   and password. `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` can do it headlessly
   for automated deploys.
4. Adoption is idempotent (`WHERE user_id IS NULL`), matching the existing workspace-adoption
   pattern in `db.js`, so re-running is safe.
5. Once adopted, make `workspaces.user_id` effectively `NOT NULL` — SQLite cannot add the
   constraint to an existing table, so enforce it in the insert helper and add a startup
   assertion that no orphan rows exist.

Take a volume backup before the first multi-user start. The `DEPLOY.md` backup command does
it in one line.

---

## 9. Phasing

Each phase is independently shippable and leaves the app working.

| Phase | Content | Rough size |
|---|---|---|
| **0 — Scoping refactor** ✅ | Request scope object; all SQL moved into `src/data/*` behind scoped accessors; `createApp()` exported; isolation test harness. | **Done.** It also fixed today's cross-workspace by-id reads as a side effect. |
| **1 — Accounts** | `users`, `sessions`, `user_settings`, `app_settings`; scrypt hashing; login/logout/me; `AUTH_MODE`; `userId` in the scope and in every accessor; per-user settings; **a per-user scratch note** (see §2); migration + setup screen; login/account UI; drop open CORS. | Medium-large. |
| **2 — Hardening** | Field encryption of API keys (§6.1); CSRF; rate limiting and lockout; secure-cookie and TLS enforcement; the full 63-endpoint isolation test; session management UI. | Medium. |
| **3 — MFA** | TOTP enrolment with QR, verification at login, encrypted recovery codes, step-up on password change. | Medium. |
| **4 — Optional** | SQLCipher at rest (§6.2); password reset by email (needs SMTP config); invite tokens; per-user data export/delete. | Small each. |

Phase 0 was the one to resist skipping: the only phase with no visible payoff, and the only
one that makes the rest safe. With it in place, phase 1 is additive — a `user_id` column, a
filter inside accessors that already exist, and the login surface — rather than a rewrite.

## 10. Deliberately out of scope

Shared workspaces, team roles, an admin console over other users' content, per-user
subdomains, SSO/OAuth, and anything that lets one account see another's data. Each would
change the ownership model that §2 and §5 depend on; adding them later means revisiting
those two sections deliberately, not extending them by accident.
