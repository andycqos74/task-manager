// Authentication endpoints. Mounted at /api/auth, outside the scoped router,
// because these are the calls that establish who the caller is.
import { Router } from 'express';
import * as Users from './data/users.js';
import {
  AUTH_MODE, authenticate, clearSessionCookie, issueSession, publicUser, registerUser,
  requireUser, revokeOtherSessions, revokeSession, hashPassword, verifyPassword,
  validateEmail, validatePassword,
} from './auth.js';
import { getAppSetting } from './db.js';

export const authRouter = Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// Registration is closed by default: on a personal deployment nobody else
// should be able to create an account just by finding the URL.
//   false (default) — only the owner can add accounts
//   true            — open sign-up
function registrationOpen() {
  const stored = getAppSetting('allow_registration');
  const value = stored ?? process.env.ALLOW_REGISTRATION ?? 'false';
  return value === 'true';
}

// What the login screen needs before anyone has signed in. Deliberately thin:
// it says whether this instance needs first-run setup and whether sign-up is
// open, and nothing about who exists.
authRouter.get('/config', (req, res) => {
  res.json({
    auth_mode: AUTH_MODE,
    setup_required: Users.countUsers() === 0,
    registration_open: registrationOpen(),
  });
});

authRouter.get('/me', requireUser, (req, res) => {
  res.json(publicUser(req.user));
});

// First run: creates the owner account and hands it everything already in the
// database. Only available while there are no users, so it cannot be used to
// mint a second owner later.
authRouter.post('/setup', async (req, res) => {
  if (Users.countUsers() > 0) return res.status(409).json({ error: 'setup has already been completed' });
  const b = req.body || {};
  const emailError = validateEmail(b.email);
  if (emailError) return badRequest(res, emailError);
  const passwordError = validatePassword(b.password);
  if (passwordError) return badRequest(res, passwordError);
  const user = await registerUser({ email: b.email, password: b.password, displayName: b.display_name });
  issueSession(res, user.id, req);
  res.status(201).json(publicUser(user));
});

authRouter.post('/register', async (req, res) => {
  if (Users.countUsers() === 0) return badRequest(res, 'this instance needs setup first');
  if (!registrationOpen()) return res.status(403).json({ error: 'registration is closed' });
  const b = req.body || {};
  const emailError = validateEmail(b.email);
  if (emailError) return badRequest(res, emailError);
  const passwordError = validatePassword(b.password);
  if (passwordError) return badRequest(res, passwordError);
  if (Users.findByEmail(b.email)) {
    // An account already exists. Saying so lets anyone enumerate addresses, so
    // the answer is the same one a bad password gets.
    return badRequest(res, 'could not create that account');
  }
  const user = await registerUser({ email: b.email, password: b.password, displayName: b.display_name });
  issueSession(res, user.id, req);
  res.status(201).json(publicUser(user));
});

authRouter.post('/login', async (req, res) => {
  const b = req.body || {};
  if (typeof b.email !== 'string' || typeof b.password !== 'string') {
    return badRequest(res, 'email and password are required');
  }
  const { user, error } = await authenticate(b.email, b.password);
  if (error) return res.status(401).json({ error });
  issueSession(res, user.id, req);
  res.json(publicUser(user));
});

authRouter.post('/logout', (req, res) => {
  revokeSession(req, res);
  res.status(204).end();
});

authRouter.patch('/me', requireUser, (req, res) => {
  const b = req.body || {};
  if ('display_name' in b) {
    if (typeof b.display_name !== 'string' || b.display_name.length > 100) {
      return badRequest(res, 'display_name must be a string of at most 100 characters');
    }
    Users.setDisplayName(req.user.id, b.display_name.trim());
  }
  res.json(publicUser(Users.getUser(req.user.id)));
});

// Changing a password signs out every other device: if the reason for the
// change is that someone else had it, leaving their session alive defeats it.
authRouter.post('/password', requireUser, async (req, res) => {
  const b = req.body || {};
  const passwordError = validatePassword(b.new_password);
  if (passwordError) return badRequest(res, passwordError);
  // An account with no usable password (the implicit single-mode owner) is
  // setting one for the first time, so there is nothing to verify against.
  const needsCurrent = req.user.password_hash !== '!';
  if (needsCurrent && !(await verifyPassword(b.current_password || '', req.user.password_hash))) {
    return badRequest(res, 'current password is incorrect');
  }
  Users.setPassword(req.user.id, await hashPassword(b.new_password));
  revokeOtherSessions(req, req.user.id);
  res.status(204).end();
});

authRouter.get('/sessions', requireUser, (req, res) => {
  res.json(Users.listSessions(req.user.id).map((s) => ({
    // The hash is the session's identity here; the token itself only ever
    // existed in the cookie.
    id: s.token_hash.slice(0, 12),
    created_at: s.created_at,
    last_seen_at: s.last_seen_at,
    expires_at: s.expires_at,
    user_agent: s.user_agent,
    ip: s.ip,
    current: s.token_hash === req.sessionHash,
  })));
});

authRouter.delete('/sessions/:id', requireUser, (req, res) => {
  const match = Users.listSessions(req.user.id).find((s) => s.token_hash.slice(0, 12) === req.params.id);
  if (!match) return res.status(404).json({ error: 'session not found' });
  Users.deleteSession(match.token_hash);
  if (match.token_hash === req.sessionHash) clearSessionCookie(res);
  res.status(204).end();
});
