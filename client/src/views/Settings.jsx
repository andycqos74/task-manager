import React, { useState } from 'react';
import { api, formatEstimate } from '../api.js';

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
      </div>
      <div className="banner info" style={{ marginTop: 24 }}>
        <strong>How Do dates work:</strong> by default, Do date = Due date − Estimated TTC. The due date itself
        counts as a working day, so a task that fits within one workday starts on its due date; only whole extra
        workdays push the start earlier. Editing a Do date directly makes it manual; use "reset" in the task panel
        to return to automatic.
      </div>
    </div>
  );
}
