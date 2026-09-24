import React, { useEffect, useState } from 'react';
import { api, formatEstimate } from '../api.js';
import { disablePush, enablePush, pushStatus, pushUnavailableReason } from '../pwa.js';

export default function Settings({ settings, refresh, onError }) {
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  async function save(body) {
    try {
      await api.patch('/settings', body);
      refresh();
    } catch (err) {
      onError(err);
    }
  }

  async function saveKey() {
    const key = keyInput.trim();
    if (!key) return;
    setSavingKey(true);
    try {
      await api.patch('/settings', { anthropic_api_key: key });
      setKeyInput('');
      refresh();
    } catch (err) {
      onError(err);
    } finally {
      setSavingKey(false);
    }
  }

  async function removeKey() {
    if (!confirm('Remove the saved API key? AI features will fall back to the ANTHROPIC_API_KEY environment variable, if one is set on the server.')) return;
    try {
      await api.patch('/settings', { anthropic_api_key: '' });
      refresh();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <div className="view">
      <header className="view-header"><h2>Settings</h2></header>

      <WorkspaceSettings refresh={refresh} onError={onError} />

      <label className="section-label">General</label>
      <div className="field-grid settings-fields">
        <label>Workday length</label>
        <div className="inline">
          <input
            type="number" min="1" max="24" step="0.5"
            defaultValue={settings.workday_minutes / 60}
            onBlur={(e) => save({ workday_minutes: Math.round(Number(e.target.value) * 60) })}
          />
          <span className="hint">hours — used for Do-date defaults and workload warnings ({formatEstimate(settings.workday_minutes)})</span>
        </div>

        <label>AI planning</label>
        <div>
          {settings.ai_available ? (
            <span className="ai-badge on">Enabled — Claude will plan and prioritise your tasks.</span>
          ) : (
            <span className="hint">Disabled. Add a Claude API key below to enable AI planning. Until then, built-in
              rules (deadlines, priorities, workload) are used.</span>
          )}
        </div>

        <label>Claude API key</label>
        <div>
          {settings.ai_key_source === 'settings' && (
            <div className="inline" style={{ marginBottom: 6 }}>
              <span className="badge">key saved · ···· {settings.ai_key_last4}</span>
              <button className="link" onClick={removeKey}>remove</button>
            </div>
          )}
          {settings.ai_key_source === 'env' && (
            <div className="hint" style={{ marginBottom: 6 }}>
              Using the <code>ANTHROPIC_API_KEY</code> environment variable. Save a key here to override it —
              a key saved in Settings takes precedence and can be changed without restarting the server.
            </div>
          )}
          <div className="inline">
            <input
              type="password"
              autoComplete="off"
              placeholder="sk-ant-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveKey()}
            />
            <button className="btn-outline" onClick={saveKey} disabled={savingKey || !keyInput.trim()}>
              {settings.ai_key_source === 'settings' ? 'Update key' : 'Save key'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Stored in the app's database on this server, never shown again after saving.
          </div>
        </div>

        <label>AI instructions</label>
        <div>
          <textarea
            rows={3}
            className="ai-prompt-field"
            defaultValue={settings.ai_prompt || ''}
            placeholder="e.g. Prioritise client-facing work in the mornings; batch admin tasks on Fridays; I prefer to tackle the hardest task first."
            onBlur={(e) => save({ ai_prompt: e.target.value })}
          />
          <div className="hint" style={{ marginTop: 4 }}>
            Optional — extra guidance Claude uses when planning My Day or prioritising tasks, on top of the built-in rules
            (deadlines, priority, dependencies, workload).
          </div>
        </div>
      </div>

      <NotificationSettings settings={settings} save={save} onError={onError} />

      <div className="banner info" style={{ marginTop: 24 }}>
        <strong>How Do dates work:</strong> by default, Do date = Due date − Estimated TTC. The due date itself
        counts as a working day, so a task that fits within one workday starts on its due date; only whole extra
        workdays push the start earlier. Editing a Do date directly makes it manual; use "reset" in the task panel
        to return to automatic.
      </div>
    </div>
  );
}

// The daily digest: one push each morning listing what's overdue, due today
// and in My Day. Turning it on subscribes *this* browser; each device the
// person wants it on is switched on separately.
function NotificationSettings({ settings, save, onError }) {
  const unavailable = pushUnavailableReason();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (unavailable) return;
    pushStatus().then(setStatus).catch(() => setStatus({ subscribed: false, permission: 'default' }));
  }, [unavailable]);

  async function toggle() {
    setBusy(true);
    setNotice(null);
    try {
      if (status?.subscribed) await disablePush();
      else await enablePush();
      setStatus(await pushStatus());
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    try {
      const { sent } = await api.post('/push/test');
      setNotice(sent ? 'Test sent — it should arrive in a few seconds.' : 'No device could be reached. Try turning notifications off and on again.');
    } catch (err) {
      onError(err);
    }
  }

  return (
    <>
      <label className="section-label">Notifications</label>
      <div className="field-grid settings-fields">
        <label>This device</label>
        <div>
          {unavailable ? (
            <span className="hint">{unavailable}</span>
          ) : status?.permission === 'denied' ? (
            <span className="hint">Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.</span>
          ) : (
            <div className="inline">
              <button className="btn-outline" onClick={toggle} disabled={busy || !status}>
                {status?.subscribed ? 'Turn off on this device' : 'Turn on for this device'}
              </button>
              {status?.subscribed && <button className="link" onClick={sendTest}>send a test</button>}
            </div>
          )}
          {notice && <div className="hint" style={{ marginTop: 4 }}>{notice}</div>}
        </div>

        <label>Daily digest</label>
        <div>
          <div className="inline">
            <label className="inline">
              <input
                type="checkbox"
                checked={settings.digest_enabled !== false}
                onChange={(e) => save({ digest_enabled: e.target.checked })}
              />
              Send at
            </label>
            <input
              type="time"
              key={settings.digest_time}
              defaultValue={settings.digest_time || '09:00'}
              disabled={settings.digest_enabled === false}
              onBlur={(e) => e.target.value && e.target.value !== settings.digest_time && save({ digest_time: e.target.value })}
            />
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            A morning summary of overdue tasks, tasks due today and your My Day list, sent to every device you've turned
            notifications on for. Skipped on days with nothing to report. Times follow the server's clock.
          </div>
        </div>
      </div>
    </>
  );
}

// Workspaces are the top level: each keeps its own projects, tasks, notes,
// ideas/bugs, dev hierarchy and boards. Switching is done from the header chip;
// this is where they're created, renamed and deleted.
function WorkspaceSettings({ refresh, onError }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [name, setName] = useState('');

  function load() {
    api.get('/workspaces').then((d) => { setWorkspaces(d.workspaces); setActiveId(d.active_id); }).catch(onError);
  }
  useEffect(load, []);

  const run = (p) => p.then(() => { load(); refresh(); }).catch(onError);

  function create(e) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    run(api.post('/workspaces', { name: n })).then(() => setName(''));
  }

  function remove(ws) {
    if (workspaces.length <= 1) { onError(new Error('Keep at least one workspace')); return; }
    if (!confirm(`Delete "${ws.name}"? Everything in it — projects, tasks, notes, ideas, bugs and boards — is permanently deleted.`)) return;
    run(api.delete(`/workspaces/${ws.id}`));
  }

  return (
    <>
      <label className="section-label">Workspaces</label>
      <div className="hint" style={{ marginBottom: 8 }}>
        Each workspace keeps its own projects, tasks, notes, ideas, bugs and boards — switch between them from the
        chip in the header. Settings below and the scratch pad are shared by all workspaces. Work can be moved
        across: a project (with its tasks, epics, stories, ideas and bugs), a single task, or a board, each from
        its own panel.
      </div>
      <div className="col-config-list">
        {workspaces.map((ws) => (
          <div key={ws.id} className="col-config-row">
            <span className="ws-dot" style={{ background: ws.color }} />
            <input
              key={`ws-${ws.id}-${ws.updated_at}`}
              defaultValue={ws.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== ws.name && run(api.patch(`/workspaces/${ws.id}`, { name: e.target.value }))}
            />
            {ws.id === activeId && <span className="badge">active</span>}
            <button className="link danger-link" onClick={() => remove(ws)} title="Delete workspace">✕</button>
          </div>
        ))}
      </div>
      <form className="col-config-add" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New workspace name" />
        <button type="submit" className="btn-outline">Add workspace</button>
      </form>
    </>
  );
}
