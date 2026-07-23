import React, { useEffect, useState } from 'react';
import { api, parseEstimate, formatEstimate, todayISO } from '../api.js';
import { SunIcon } from '../icons.jsx';

// Full task editor, shown as a right-hand panel. Every change saves
// immediately (PATCH), so quick-captured tasks can be enriched over time.
export default function TaskDetail({ taskId, projects, settings, onClose, onChanged, onError }) {
  const [task, setTask] = useState(null);
  const [estimateText, setEstimateText] = useState('');
  const [newSubtask, setNewSubtask] = useState('');
  const [tagText, setTagText] = useState('');
  const [candidates, setCandidates] = useState([]);

  async function load() {
    try {
      const t = await api.get(`/tasks/${taskId}`);
      setTask(t);
      setEstimateText(formatEstimate(t.estimated_minutes, settings.workday_minutes));
      setTagText(t.tags.join(', '));
    } catch (err) {
      onError?.(err);
      onClose?.();
    }
  }

  useEffect(() => { load(); }, [taskId]);

  useEffect(() => {
    // Candidate tasks for the dependency picker (same project or inbox).
    api.get('/tasks?include_done=1').then(setCandidates).catch(() => {});
  }, [taskId]);

  if (!task) return null;

  async function patch(body) {
    try {
      const updated = await api.patch(`/tasks/${task.id}`, body);
      setTask(updated);
      setEstimateText(formatEstimate(updated.estimated_minutes, settings.workday_minutes));
      onChanged?.();
      if (updated.spawned_task) onChanged?.();
    } catch (err) {
      onError?.(err);
      load();
    }
  }

  function saveEstimate() {
    const minutes = parseEstimate(estimateText, settings.workday_minutes);
    if (estimateText.trim() && minutes == null) {
      onError?.(new Error('Could not read estimate — try "2h", "90m" or "1d 4h"'));
      return;
    }
    patch({ estimated_minutes: minutes });
  }

  function saveTags() {
    const tags = tagText.split(',').map((t) => t.trim()).filter(Boolean);
    patch({ tags });
  }

  async function addSubtask(e) {
    e.preventDefault();
    const title = newSubtask.trim();
    if (!title) return;
    try {
      const updated = await api.post(`/tasks/${task.id}/subtasks`, { title });
      setTask(updated);
      setNewSubtask('');
      onChanged?.();
    } catch (err) {
      onError?.(err);
    }
  }

  async function setSubtask(id, body) {
    try {
      setTask(await api.patch(`/subtasks/${id}`, body));
      onChanged?.();
    } catch (err) {
      onError?.(err);
    }
  }

  async function removeSubtask(id) {
    try {
      setTask(await api.delete(`/subtasks/${id}`));
      onChanged?.();
    } catch (err) {
      onError?.(err);
    }
  }

  async function setDependencies(ids) {
    try {
      setTask(await api.put(`/tasks/${task.id}/dependencies`, { depends_on_ids: ids }));
      onChanged?.();
    } catch (err) {
      onError?.(err);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${task.title}"?`)) return;
    try {
      await api.delete(`/tasks/${task.id}`);
      onChanged?.();
      onClose?.();
    } catch (err) {
      onError?.(err);
    }
  }

  async function convertToIdea() {
    if (!confirm(`Move "${task.title}" to the Backlog as an idea? The task will be removed.`)) return;
    try {
      await api.post(`/tasks/${task.id}/convert-to-idea`);
      onChanged?.();
      onClose?.();
    } catch (err) {
      onError?.(err);
    }
  }

  async function reportBug() {
    if (!confirm(`Move "${task.title}" to Bugs? The task will be removed.`)) return;
    try {
      await api.post(`/tasks/${task.id}/convert-to-bug`);
      onChanged?.();
      onClose?.();
    } catch (err) {
      onError?.(err);
    }
  }

  const inMyDay = task.my_day_date === todayISO();
  const depIds = task.dependencies.map((d) => d.id);
  const rec = task.recurrence;

  return (
    <aside className="detail-panel" onClick={(e) => e.stopPropagation()}>
      <div className="detail-header">
        <button
          className={`myday-toggle big ${inMyDay ? 'on' : ''}`}
          onClick={async () => { await api.post(`/tasks/${task.id}/my-day`, { on: !inMyDay }); load(); onChanged?.(); }}
        >
          <SunIcon width={15} height={15} /> {inMyDay ? 'In My Day' : 'Add to My Day'}
        </button>
        <button className="link" onClick={onClose}>Close ✕</button>
      </div>

      {task.story_title && (
        <div className="detail-parent">
          <span className="badge dev">⚙ {task.epic_title ? `${task.epic_title} › ` : ''}{task.story_title}</span>
        </div>
      )}

      <input
        className="detail-title"
        defaultValue={task.title}
        key={`title-${task.id}-${task.updated_at}`}
        onBlur={(e) => e.target.value.trim() !== task.title && patch({ title: e.target.value })}
      />

      <div className="field-grid">
        <label>Status</label>
        <select value={task.status} onChange={(e) => patch({ status: e.target.value })}>
          <option value="todo">To do</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
          <option value="cancelled">Cancelled</option>
        </select>

        <label>Project</label>
        <select value={task.project_id || ''} onChange={(e) => patch({ project_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">(none)</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <label>Priority</label>
        <select value={task.priority} onChange={(e) => patch({ priority: e.target.value })}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>

        <label>Due date</label>
        <input type="date" value={task.due_date || ''} onChange={(e) => patch({ due_date: e.target.value || null })} />

        <label>
          Do date
          {!task.do_date_is_manual && <span className="hint"> (auto)</span>}
        </label>
        <div className="inline">
          <input type="date" value={task.do_date || ''} onChange={(e) => patch({ do_date: e.target.value || null })} />
          {task.do_date_is_manual && (
            <button className="link" title="Reset to Due date − Estimated TTC" onClick={() => patch({ do_date_is_manual: false })}>
              reset
            </button>
          )}
        </div>

        <label>Estimated TTC</label>
        <input
          value={estimateText}
          placeholder="e.g. 2h, 90m, 1d 4h"
          onChange={(e) => setEstimateText(e.target.value)}
          onBlur={saveEstimate}
          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
        />

        <label>Repeat</label>
        <select
          value={rec ? `${rec.freq}:${rec.interval}` : ''}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return patch({ recurrence: null });
            const [freq, interval] = v.split(':');
            patch({ recurrence: { freq, interval: Number(interval) } });
          }}
        >
          <option value="">Never</option>
          <option value="daily:1">Daily</option>
          <option value="weekly:1">Weekly</option>
          <option value="weekly:2">Every 2 weeks</option>
          <option value="monthly:1">Monthly</option>
        </select>

        <label>Tags</label>
        <input
          value={tagText}
          placeholder="comma, separated"
          onChange={(e) => setTagText(e.target.value)}
          onBlur={saveTags}
          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
        />
      </div>

      <label className="section-label">Notes</label>
      <textarea
        key={`notes-${task.id}-${task.updated_at}`}
        defaultValue={task.notes}
        rows={4}
        placeholder="Add detail later…"
        onBlur={(e) => e.target.value !== task.notes && patch({ notes: e.target.value })}
      />

      <label className="section-label">Checklist</label>
      <div className="subtasks">
        {task.subtasks.map((s) => (
          <div key={s.id} className="subtask">
            <input type="checkbox" checked={s.done} onChange={(e) => setSubtask(s.id, { done: e.target.checked })} />
            <span className={s.done ? 'done' : ''}>{s.title}</span>
            <button className="link" onClick={() => removeSubtask(s.id)}>✕</button>
          </div>
        ))}
        <form onSubmit={addSubtask} className="inline">
          <input value={newSubtask} onChange={(e) => setNewSubtask(e.target.value)} placeholder="Add checklist item" />
        </form>
      </div>

      <label className="section-label">Depends on</label>
      <div className="deps">
        {task.dependencies.map((d) => (
          <div key={d.id} className="dep">
            <span className={d.done ? 'done' : ''}>{d.title}</span>
            <button className="link" onClick={() => setDependencies(depIds.filter((id) => id !== d.id))}>✕</button>
          </div>
        ))}
        <select
          value=""
          onChange={(e) => e.target.value && setDependencies([...depIds, Number(e.target.value)])}
        >
          <option value="">Add dependency…</option>
          {candidates
            .filter((c) => c.id !== task.id && !depIds.includes(c.id) && c.status !== 'done' && c.status !== 'cancelled')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.project_name ? `[${c.project_name}] ` : ''}{c.title}
              </option>
            ))}
        </select>
      </div>

      <div className="detail-footer">
        <button className="danger" onClick={remove}>Delete task</button>
        <button className="btn-outline" onClick={convertToIdea}>Convert to idea</button>
        <button className="btn-outline" onClick={reportBug}>Report bug</button>
      </div>
    </aside>
  );
}
