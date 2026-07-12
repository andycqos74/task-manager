import React, { useEffect, useState } from 'react';
import { api, formatEstimate } from '../api.js';
import QuickAdd from '../components/QuickAdd.jsx';
import TaskList from '../components/TaskList.jsx';

export default function MyDay({ refreshKey, refresh, settings, onSelectTask, onError }) {
  const [data, setData] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);

  useEffect(() => {
    api.get('/views/my-day').then(setData).catch(onError);
  }, [refreshKey]);

  async function planDay() {
    setPlanning(true);
    setPlan(null);
    try {
      setPlan(await api.post('/ai/plan-day'));
    } catch (err) {
      onError(err);
    } finally {
      setPlanning(false);
    }
  }

  async function addSuggestion(taskId) {
    try {
      await api.post(`/tasks/${taskId}/my-day`, { on: true });
      refresh();
    } catch (err) {
      onError(err);
    }
  }

  async function addAllSuggestions() {
    for (const s of plan?.suggestions || []) {
      await api.post(`/tasks/${s.task_id}/my-day`, { on: true }).catch(onError);
    }
    setPlan(null);
    refresh();
  }

  if (!data) return <div className="empty">Loading…</div>;
  const { warnings } = data;
  const inDay = new Set(data.tasks.map((t) => t.id));
  const pending = (plan?.suggestions || []).filter((s) => !inDay.has(s.task_id));

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <h2>☀️ My Day</h2>
          <div className="subtitle">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            {data.done_today > 0 && ` · ${data.done_today} done today`}
          </div>
        </div>
        <button onClick={planDay} disabled={planning}>
          {planning ? 'Thinking…' : settings.ai_available ? '✨ Plan my day (AI)' : '✨ Suggest tasks'}
        </button>
      </header>

      {(warnings.overdue_count > 0 || warnings.overloaded) && (
        <div className="banner warn">
          {warnings.overdue_count > 0 && <span>⚠ {warnings.overdue_count} overdue task{warnings.overdue_count > 1 ? 's' : ''}. </span>}
          {warnings.overloaded && (
            <span>
              ⚠ Planned work ({formatEstimate(warnings.total_estimated_minutes)}) exceeds your{' '}
              {formatEstimate(warnings.workday_minutes)} workday.
            </span>
          )}
        </div>
      )}
      {!warnings.overloaded && warnings.total_estimated_minutes > 0 && (
        <div className="banner info">
          {formatEstimate(warnings.total_estimated_minutes)} of estimated work planned today
          {' '}({formatEstimate(warnings.workday_minutes)} workday).
        </div>
      )}

      {plan && (
        <div className="ai-panel">
          <div className="ai-panel-header">
            <strong>{plan.source === 'ai' ? '✨ Claude suggests' : 'Suggestions'}</strong>
            <button className="link" onClick={() => setPlan(null)}>dismiss</button>
          </div>
          <p className="subtitle">{plan.summary}</p>
          {pending.length === 0 && <p className="subtitle">Everything suggested is already in My Day.</p>}
          {pending.map((s) => (
            <div key={s.task_id} className="suggestion">
              <button onClick={() => addSuggestion(s.task_id)} title="Add to My Day">＋</button>
              <span>{s.reason}</span>
            </div>
          ))}
          {pending.length > 1 && <button className="small" onClick={addAllSuggestions}>Add all</button>}
        </div>
      )}

      <QuickAdd defaults={{ my_day: true }} onCreated={refresh} onError={onError} placeholder="Add a task to My Day" />
      <TaskList
        tasks={data.tasks}
        empty="Nothing in My Day yet. Add tasks with the ☀ button, or let AI plan your day."
        onSelect={onSelectTask}
        onChanged={refresh}
        onError={onError}
      />
    </div>
  );
}
