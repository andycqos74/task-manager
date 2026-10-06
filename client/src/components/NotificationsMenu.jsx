import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatDate } from '../api.js';
import { BellIcon } from '../icons.jsx';

const KIND_LABEL = { overdue: 'Overdue', due_today: 'Due today', starts_today: 'Start today' };
const POLL_MS = 5 * 60 * 1000;

// The header bell: what needs attention now, across every workspace — the same
// things the morning push digest summarises. The dot shows while anything is
// unseen; opening the panel marks it all seen, but items that were new keep
// their highlight until the panel closes so you can tell which they were.
export default function NotificationsMenu({ refreshKey, activeWorkspaceId, onOpenTask, onSettings, onError }) {
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState(null);
  const [freshKeys, setFreshKeys] = useState(new Set());
  const ref = useRef(null);

  const load = useCallback(() => api.get('/notifications').then(setFeed).catch(() => {}), []);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    try {
      const latest = await api.get('/notifications');
      setFreshKeys(new Set(latest.items.filter((i) => !i.read).map((i) => i.key)));
      setFeed(latest);
      if (latest.unread > 0) setFeed(await api.post('/notifications/read', {}));
    } catch (err) {
      onError(err);
    }
  }

  function openTask(item) {
    setOpen(false);
    onOpenTask(item);
  }

  async function complete(item, e) {
    e.stopPropagation();
    try {
      // The task may be in another workspace, so name the one it lives in.
      await api.in(item.workspace_id).patch(`/tasks/${item.task_id}`, { status: 'done' });
      await load();
    } catch (err) {
      onError(err);
    }
  }

  const unread = feed?.unread || 0;
  const items = feed?.items || [];

  return (
    <div className="notif-menu" ref={ref}>
      <button
        className="header-icon-btn notif-bell"
        title={unread ? `Notifications — ${unread} new` : 'Notifications'}
        aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
        aria-expanded={open}
        onClick={toggle}
      >
        <BellIcon width={18} height={18} />
        {unread > 0 && <span className="header-dot" />}
      </button>

      {open && (
        <div className="notif-popover" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <strong>Notifications</strong>
            {feed && <span className="hint">{feed.total ? `${feed.total} need${feed.total === 1 ? 's' : ''} attention` : ''}</span>}
          </div>

          {!feed ? (
            <div className="notif-empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="notif-empty">You're all caught up — nothing overdue, due or starting today.</div>
          ) : (
            <ul className="notif-list">
              {items.map((item) => (
                <li key={item.key} className="notif-row">
                  <button className={`notif-item ${freshKeys.has(item.key) ? 'fresh' : ''}`} onClick={() => openTask(item)}>
                    <span className={`notif-kind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                    <span className="notif-title">{item.title}</span>
                    <span className="notif-meta">
                      {item.kind === 'overdue' && item.due_date && <span>due {formatDate(item.due_date)}</span>}
                      {item.project_name && (
                        <span className="badge project" style={{ '--c': item.project_color }}>{item.project_name}</span>
                      )}
                      {item.workspace_id !== activeWorkspaceId && <span className="notif-ws">in {item.workspace_name}</span>}
                    </span>
                  </button>
                  {/* Only in the active workspace: task edits are scoped to it. */}
                  {item.workspace_id === activeWorkspaceId && (
                    <button className="notif-done" title="Mark done" aria-label={`Mark "${item.title}" done`} onClick={(e) => complete(item, e)}>✓</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {feed && feed.total > items.length && (
            <div className="hint notif-more">Showing the first {items.length} of {feed.total}.</div>
          )}

          <button className="account-link notif-settings" onClick={() => { setOpen(false); onSettings(); }}>
            Push notification settings
          </button>
        </div>
      )}
    </div>
  );
}
