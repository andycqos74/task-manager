import React, { useEffect, useRef, useState } from 'react';

// One-click workspace switcher, pinned in the top header. Workspaces keep
// projects, tasks, notes, ideas/bugs and boards separate; settings and the
// scratch pad are shared across all of them.
export default function WorkspaceSwitcher({ workspaces, activeId, onSwitch, onManage }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const active = workspaces.find((w) => w.id === activeId);
  if (!active) return null;

  return (
    <div className="ws-switcher" ref={ref}>
      <button className="ws-chip" onClick={() => setOpen((o) => !o)} title="Switch workspace">
        <span className="ws-dot" style={{ background: active.color }} />
        <span className="ws-name">{active.name}</span>
        <span className="ws-caret">▾</span>
      </button>
      {open && (
        <div className="ws-menu">
          <div className="ws-menu-head">Workspaces</div>
          {workspaces.map((w) => (
            <button
              key={w.id}
              className={`ws-menu-item ${w.id === activeId ? 'active' : ''}`}
              onClick={() => { setOpen(false); if (w.id !== activeId) onSwitch(w.id); }}
            >
              <span className="ws-dot" style={{ background: w.color }} />
              <span className="ws-name">{w.name}</span>
              {w.id === activeId && <span className="ws-tick">✓</span>}
            </button>
          ))}
          <div className="ws-menu-sep" />
          <button className="ws-menu-item manage" onClick={() => { setOpen(false); onManage(); }}>
            Manage workspaces…
          </button>
        </div>
      )}
    </div>
  );
}
