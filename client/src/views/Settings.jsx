import React from 'react';
import { api, formatEstimate } from '../api.js';

export default function Settings({ settings, refresh, onError }) {
  async function save(body) {
    try {
      await api.patch('/settings', body);
      refresh();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <div className="view">
      <header className="view-header"><h2>⚙️ Settings</h2></header>
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
            <span>
              Disabled. Set the <code>ANTHROPIC_API_KEY</code> environment variable on the server and restart to
              enable AI planning. Until then, built-in rules (deadlines, priorities, workload) are used.
            </span>
          )}
        </div>
      </div>
      <div className="banner info" style={{ marginTop: 24 }}>
        <strong>How Do dates work:</strong> by default, Do date = Due date − Estimated TTC (rounded up to whole
        workdays). Editing a Do date directly makes it manual; use "reset" in the task panel to return to automatic.
      </div>
    </div>
  );
}
