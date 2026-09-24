import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// The header avatar, and what sits behind it: who you are, changing your
// password, and signing out.
//
// In single-user mode there is no session to end, so the menu shows the mode
// rather than a sign-out button that would do nothing.
export default function AccountMenu({ user, beforeSignOut, onSignedOut, onError }) {
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [notice, setNotice] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const multi = user?.auth_mode === 'multi';
  const label = (user?.display_name || user?.email || '?').trim().charAt(0).toUpperCase();

  async function signOut() {
    try {
      await beforeSignOut?.();
      await api.post('/auth/logout');
      onSignedOut();
    } catch (err) {
      onError(err);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    setNotice(null);
    try {
      await api.post('/auth/password', { current_password: current, new_password: next });
      setCurrent(''); setNext(''); setChanging(false);
      setNotice('Password changed. Other devices have been signed out.');
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <div className="account-menu" ref={ref}>
      <button className="header-avatar" title="Account" onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && (
        <div className="account-popover">
          <div className="account-identity">
            <strong>{user?.display_name || user?.email}</strong>
            {user?.display_name && <span className="hint">{user.email}</span>}
          </div>

          {notice && <div className="banner info account-notice">{notice}</div>}

          {!multi && (
            <p className="hint account-single-note">
              Single-user mode — this instance has no sign-in. Set <code>AUTH_MODE=multi</code> to
              turn on accounts.
            </p>
          )}

          {changing ? (
            <form className="account-form" onSubmit={changePassword}>
              {multi && (
                <input
                  className="signin-input" type="password" placeholder="Current password"
                  autoComplete="current-password" value={current}
                  onChange={(e) => setCurrent(e.target.value)} required
                />
              )}
              <input
                className="signin-input" type="password" placeholder="New password (12+ characters)"
                autoComplete="new-password" value={next}
                onChange={(e) => setNext(e.target.value)} required
              />
              <div className="account-actions">
                <button type="submit" className="ai-action-btn">Save</button>
                <button type="button" className="account-link" onClick={() => setChanging(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button className="account-link" onClick={() => { setChanging(true); setNotice(null); }}>
              Change password
            </button>
          )}

          {multi && <button className="account-link danger-link" onClick={signOut}>Sign out</button>}
        </div>
      )}
    </div>
  );
}
