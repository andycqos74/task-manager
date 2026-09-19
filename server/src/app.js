// Builds the express app. Kept separate from index.js so tests can drive the
// real app in-process — including its middleware — rather than assembling a
// partial copy of it and testing something the server never runs.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { router } from './routes.js';
import { authRouter } from './auth-routes.js';
import { attachScope } from './scope.js';
import { AUTH_MODE, attachUser, ensureSingleModeOwner, parseCookies, requireUser, secureCookies } from './auth.js';
import { purgeExpiredSessions } from './data/users.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// CSRF defence, and the reason there is no CORS policy below.
//
// Every state-changing request must declare application/json — including the
// ones that carry no body. That is not a formality:
//
//   * A cross-site HTML form can only send urlencoded, multipart or
//     text/plain, so it can never satisfy this.
//   * A cross-origin fetch CAN set application/json, but doing so makes the
//     request non-simple, so the browser sends a preflight first. We answer no
//     CORS headers, so the real request is never sent.
//   * The tempting exemption — allow a missing content-type when there is no
//     body — would reopen it. A bodyless cross-origin POST is a *simple*
//     request: the browser sends it with the user's cookie and merely hides
//     the response, which is no comfort when the point of the endpoint is its
//     side effect. So bodyless requests must declare the type too.
//
// Phase 2 adds a double-submit token on top of this.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function requireJsonContentType(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  const type = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    return res.status(415).json({ error: 'requests must be sent as application/json' });
  }
  next();
}

export function createApp({ serveClient = true } = {}) {
  const app = express();

  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

  // No CORS. The UI is served from this same origin, so nothing needs
  // cross-origin access — and now that requests carry a session cookie,
  // granting it would be handing the API to any page the user visits.
  app.use(express.json({ limit: '2mb' }));
  app.use(parseCookies);
  app.use('/api', requireJsonContentType);

  // Establish who the caller is, then what they may touch. In single mode
  // attachUser always resolves the implicit owner, so requireUser never
  // rejects and there is no login screen.
  app.use('/api', attachUser);
  app.use('/api/auth', authRouter);
  app.use('/api', requireUser, attachScope, router);

  // Serve the built frontend in production (npm run build first).
  const dist = path.join(here, '..', '..', 'client', 'dist');
  if (serveClient && fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

// Called once at startup: create the implicit owner in single mode, warn about
// an insecure multi-user deployment, and sweep dead sessions.
export function bootstrap() {
  if (AUTH_MODE === 'single') {
    ensureSingleModeOwner();
  } else if (!secureCookies()) {
    // A session cookie without Secure travels in clear text, and a login page
    // over plain HTTP can be read or rewritten in transit. Refuse rather than
    // quietly run an insecure multi-user server.
    if (process.env.ALLOW_INSECURE !== '1') {
      throw new Error(
        'AUTH_MODE=multi needs TLS. Put the app behind a reverse proxy and set TRUST_PROXY=1 ' +
        '(or NODE_ENV=production). To run without TLS anyway — only sensible on a trusted ' +
        'network — set ALLOW_INSECURE=1.',
      );
    }
    console.warn('WARNING: AUTH_MODE=multi without TLS. Session cookies are sent in clear text.');
  }
  purgeExpiredSessions();
  // Sessions expire on read too; this just keeps the table from growing.
  const hourly = setInterval(purgeExpiredSessions, 60 * 60 * 1000);
  hourly.unref?.();
}
