import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { BrandMark, Wordmark } from '../components/Brand.jsx';

// The pre-authentication screen. It is one component covering three states,
// because they are the same form with different copy:
//
//   setup    — no accounts exist yet; the first one created owns whatever is
//              already in the database (see adoptOrphanData in db.js)
//   login    — the normal case
//   register — only when the instance has sign-up open
//
// Never rendered in single-user mode: there, /auth/me always succeeds.
export default function SignIn({ onSignedIn }) {
  // Fetched here rather than passed in, because it changes underneath us: once
  // the owner account exists, setup is over. A cached copy from app boot would
  // put us back on the setup form after the first sign-out.
  const [config, setConfig] = useState(null);
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // A failed Google sign-in comes back as /?auth_error=… — show it once and
  // tidy the address bar.
  const [error, setError] = useState(() => {
    const message = new URLSearchParams(window.location.search).get('auth_error');
    if (message) window.history.replaceState(null, '', window.location.pathname);
    return message;
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/auth/config')
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        setMode(c.setup_required ? 'setup' : 'login');
      })
      .catch(() => { if (!cancelled) setConfig({ setup_required: false, registration_open: false }); });
    return () => { cancelled = true; };
  }, []);

  const creating = mode === 'setup' || mode === 'register';

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (creating && password !== confirm) {
      setError('the two passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const path = mode === 'setup' ? '/auth/setup' : mode === 'register' ? '/auth/register' : '/auth/login';
      const user = await api.post(path, { email, password });
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Don't render the form until we know which of the three it is — a flash of
  // "create the owner account" on a normal sign-in is alarming.
  if (!config) return <div className="app-booting" />;

  return (
    <div className="signin-shell">
      <form className="signin-card" onSubmit={submit}>
        <div className="signin-brand">
          <BrandMark theme="light" size={44} />
          <Wordmark className="signin-wordmark" />
        </div>

        {config.setup_required && mode === 'setup' && (
          <p className="signin-lead">
            No account exists yet. The first one you create becomes the owner and takes over
            everything already in this instance.
          </p>
        )}

        <label className="signin-label" htmlFor="signin-email">Email</label>
        <input
          id="signin-email" className="signin-input" type="email" autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus
        />

        <label className="signin-label" htmlFor="signin-password">Password</label>
        <input
          id="signin-password" className="signin-input" type="password"
          autoComplete={creating ? 'new-password' : 'current-password'}
          value={password} onChange={(e) => setPassword(e.target.value)} required
        />
        {creating && <span className="hint">At least 12 characters. A memorable phrase beats a short tangle of symbols.</span>}

        {creating && (
          <>
            <label className="signin-label" htmlFor="signin-confirm">Confirm password</label>
            <input
              id="signin-confirm" className="signin-input" type="password" autoComplete="new-password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} required
            />
          </>
        )}

        {error && <div className="banner warn signin-error">{error}</div>}

        <button className="signin-submit" type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'setup' ? 'Create owner account' : mode === 'register' ? 'Create account' : 'Sign in'}
        </button>

        {config.google_enabled && (
          <>
            <div className="signin-or"><span>or</span></div>
            {/* A plain navigation, not fetch: the browser goes to Google and back. */}
            <a className="signin-google" href="/api/auth/google/start">
              <GoogleG /> {mode === 'login' ? 'Sign in with Google' : 'Continue with Google'}
            </a>
          </>
        )}

        {!config.setup_required && config.registration_open && (
          <button
            type="button" className="signin-switch"
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
          >
            {mode === 'login' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
          </button>
        )}
      </form>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
