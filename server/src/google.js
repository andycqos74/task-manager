// "Sign in with Google" — OpenID Connect authorization-code flow with PKCE,
// no dependencies.
//
// Enabled in multi mode when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are
// set. The redirect URI registered with Google must be
//   <PUBLIC_URL>/api/auth/google/callback
// PUBLIC_URL is optional; without it the URI is built from the request, which
// behind a proxy needs TRUST_PROXY=1 so the scheme comes out as https.
//
// The ID token is taken straight from Google's token endpoint over TLS, in
// exchange for a code only this server's secret can redeem, so — as OpenID
// Connect Core 3.1.3.7 allows — its issuer is vouched for by TLS rather than
// by checking the signature. Its claims (iss, aud, exp, nonce,
// email_verified) are still all checked.
import crypto from 'node:crypto';
import { AUTH_MODE } from './auth.js';

const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export const STATE_COOKIE = 'tm_oauth';
const STATE_TTL_SECONDS = 600;

export function googleEnabled() {
  return AUTH_MODE === 'multi' && !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

export function redirectUri(req) {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/api/auth/google/callback`;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Everything the callback needs to prove it is finishing the flow this
// browser started: state (CSRF), nonce (token replay) and the PKCE verifier.
export function beginFlow(req) {
  const flow = {
    state: b64url(crypto.randomBytes(24)),
    nonce: b64url(crypto.randomBytes(24)),
    verifier: b64url(crypto.randomBytes(32)),
    expires: Date.now() + STATE_TTL_SECONDS * 1000,
  };
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: b64url(crypto.createHash('sha256').update(flow.verifier).digest()),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { flow, cookieValue: b64url(JSON.stringify(flow)), url: `${AUTH_URL}?${params}`, maxAge: STATE_TTL_SECONDS * 1000 };
}

export function readFlow(cookieValue) {
  try {
    const flow = JSON.parse(Buffer.from(cookieValue || '', 'base64url').toString());
    if (typeof flow.state !== 'string' || typeof flow.nonce !== 'string' || typeof flow.verifier !== 'string') return null;
    if (!(flow.expires > Date.now())) return null;
    return flow;
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class GoogleAuthError extends Error {}

// Redeem the code and return the verified identity { subject, email, name }.
export async function finishFlow(req, flow, { code, state }) {
  if (!code || !state || !safeEqual(state, flow.state)) throw new GoogleAuthError('sign-in expired, please try again');
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code: String(code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(req),
        grant_type: 'authorization_code',
        code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new GoogleAuthError('could not reach Google');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.id_token !== 'string') throw new GoogleAuthError('Google did not accept the sign-in');

  let claims;
  try {
    claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
  } catch {
    throw new GoogleAuthError('Google returned an unreadable token');
  }
  const now = Math.floor(Date.now() / 1000);
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(process.env.GOOGLE_CLIENT_ID) : claims.aud === process.env.GOOGLE_CLIENT_ID;
  if (!ISSUERS.has(claims.iss) || !audOk || !(claims.exp > now) || !safeEqual(claims.nonce || '', flow.nonce) || !claims.sub) {
    throw new GoogleAuthError('Google returned a token that did not check out');
  }
  if (!claims.email || (claims.email_verified !== true && claims.email_verified !== 'true')) {
    throw new GoogleAuthError('your Google account has no verified email address');
  }
  return { subject: String(claims.sub), email: String(claims.email), name: claims.name ? String(claims.name).slice(0, 100) : '' };
}
