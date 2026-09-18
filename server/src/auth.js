// Passwords, sessions and the middleware that turns a cookie into req.user.
//
// Two run modes, chosen by AUTH_MODE (see BRANCHING.md):
//
//   single (default) — one implicit owner, auto-authenticated on every
//                      request, no login screen. This is the personal
//                      deployment, and it behaves exactly as before accounts
//                      existed.
//   multi            — real accounts: email + password, a session cookie, and
//                      a login screen.
//
// The data model is identical in both. Single mode is a deployment choice, not
// a different product, so there is one code path to get right.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { adoptOrphanData, seedNewUser } from './db.js';
import * as Users from './data/users.js';

const scrypt = promisify(crypto.scrypt);

export const AUTH_MODE = process.env.AUTH_MODE === 'multi' ? 'multi' : 'single';
export const SESSION_COOKIE = 'tm_session';
const SESSION_TTL_SECONDS = Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 30) * 24 * 60 * 60;
const LOCK_AFTER = 5;          // failed logins before the first lockout
const LOCK_SECONDS = 900;      // 15 minutes, doubling per further failure
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200; // bounds the hashing work an attacker can ask for

// The placeholder hash for the implicit single-mode owner: no password can
// produce it, so the account cannot be logged into even if the server is
// later switched to multi mode without setting one.
const UNUSABLE_PASSWORD = '!';

// ---------- passwords ----------
//
// scrypt from node:crypto: memory-hard, no dependency, no native build beyond
// what the project already has. The parameters are stored alongside the hash
// so they can be raised later without invalidating existing passwords.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(32);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || stored === UNUSABLE_PASSWORD) return false;
  const [scheme, N, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, salt, expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2,
  });
  return crypto.timingSafeEqual(key, expected);
}

export function validatePassword(password) {
  if (typeof password !== 'string') return 'password must be a string';
  if (password.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  const weak = ['password', '123456789012', 'qwertyuiop', 'letmeinplease', 'administrator'];
  if (weak.some((w) => password.toLowerCase().includes(w))) return 'password is too easy to guess';
  return null;
}

export function validateEmail(email) {
  const e = Users.normaliseEmail(email);
  // Deliberately loose: the only thing that actually validates an address is
  // sending to it, and over-strict patterns reject real addresses.
  if (!e || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'a valid email address is required';
  return null;
}

// ---------- sessions ----------

// Minimal cookie parsing. express ships res.cookie but not the read side, and
// one small function is easier to audit than another dependency.
export function parseCookies(req, res, next) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue; // first wins, as browsers send most-specific first
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()); } catch { /* skip malformed */ }
  }
  req.cookies = out;
  next();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Only the hash is stored, so a copy of the database yields no usable session.
export function issueSession(res, userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  Users.createSession({
    tokenHash: hashToken(token),
    userId,
    ttlSeconds: SESSION_TTL_SECONDS,
    userAgent: req.get?.('user-agent'),
    ip: req.ip,
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Set whenever TLS is terminated in front of us. Without it the cookie
    // travels in clear on the plain-HTTP deployments the README describes.
    secure: secureCookies(),
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
  return token;
}

export function secureCookies() {
  return process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production';
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secureCookies(), path: '/' });
}

export function currentSessionHash(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  return token ? hashToken(token) : null;
}

export function revokeSession(req, res) {
  const hash = currentSessionHash(req);
  if (hash) Users.deleteSession(hash);
  clearSessionCookie(res);
}

export function revokeOtherSessions(req, userId) {
  Users.deleteUserSessions(userId, { except: currentSessionHash(req) });
}

// ---------- first run ----------

// In single mode the owner is implicit: created on first start, with an
// unusable password and no login screen. Any data predating accounts is
// adopted by them, so upgrading in place is invisible.
export function ensureSingleModeOwner() {
  const existing = Users.firstUser();
  if (existing) return existing;
  const user = Users.createUser({
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || 'owner@localhost',
    passwordHash: UNUSABLE_PASSWORD,
    displayName: 'Owner',
    role: 'owner',
  });
  adoptOrphanData(user.id);
  return user;
}

// ---------- middleware ----------

// Resolve req.user. In single mode that is always the implicit owner, so every
// downstream check behaves identically in both modes.
export function attachUser(req, res, next) {
  if (AUTH_MODE === 'single') {
    req.user = singleModeOwner();
    return next();
  }
  const hash = currentSessionHash(req);
  if (!hash) return next();
  const session = Users.sessionByHash(hash);
  if (!session) return next();
  Users.touchSession(hash, SESSION_TTL_SECONDS);
  req.user = Users.getUser(session.user_id);
  req.sessionHash = hash;
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) {
    // `setup_required` lets the client show first-run instead of a login form.
    return res.status(401).json({
      error: 'authentication required',
      setup_required: Users.countUsers() === 0,
    });
  }
  next();
}

// Cached because single mode resolves it on every request.
let cachedOwner = null;
function singleModeOwner() {
  if (cachedOwner && Users.getUser(cachedOwner.id)) return cachedOwner;
  cachedOwner = ensureSingleModeOwner();
  return cachedOwner;
}

// ---------- account creation ----------

// The first account owns whatever was already in the database; later ones
// start empty.
export async function registerUser({ email, password, displayName }) {
  const isFirst = Users.countUsers() === 0;
  const user = Users.createUser({
    email,
    passwordHash: await hashPassword(password),
    displayName: displayName || '',
    role: isFirst ? 'owner' : 'user',
  });
  if (isFirst) adoptOrphanData(user.id);
  else seedNewUser(user.id);
  return user;
}

// Same answer and roughly the same work for an unknown email, a wrong password
// and a locked account, so the response does not say which.
export async function authenticate(email, password) {
  const user = Users.findByEmail(email);
  if (!user || !user.is_active) {
    await hashPassword('decoy-work-so-timing-does-not-leak');
    return { error: 'invalid email or password' };
  }
  if (Users.lockedUntil(user)) {
    await hashPassword('decoy-work-so-timing-does-not-leak');
    return { error: 'invalid email or password' };
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    Users.recordLoginFailure(user.id, { lockAfter: LOCK_AFTER, lockSeconds: LOCK_SECONDS });
    return { error: 'invalid email or password' };
  }
  Users.clearLoginFailures(user.id);
  return { user };
}

// What the client is told about the signed-in account. Never the hash.
export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    totp_enabled: !!user.totp_enabled,
    auth_mode: AUTH_MODE,
  };
}
