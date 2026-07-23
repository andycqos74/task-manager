import React from 'react';
import { api, formatDate, formatEstimate, todayISO } from '../api.js';
import { SunIcon } from '../icons.jsx';

const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', medium: '', low: 'Low' };

export function TaskRow({ task, onSelect, onChanged, onError, showProject = true }) {
  const done = task.status === 'done';
  const overdue = !done && task.due_date && task.due_date < todayISO();
  const inMyDay = task.my_day_date === todayISO();

  async function toggleDone(e) {
    e.stopPropagation();
    try {
      await api.patch(`/tasks/${task.id}`, { status: done ? 'todo' : 'done' });
      onChanged?.();
    } catch (err) {
      onError?.(err);
    }
  }

  async function toggleMyDay(e) {
    e.stopPropagation();
    try {
      await api.post(`/tasks/${task.id}/my-day`, { on: !inMyDay });
      onChanged?.();
    } catch (err) {
      onError?.(err);
    }
  }

  const subDone = task.subtasks?.filter((s) => s.done).length || 0;

  return (
    <div className={`task-row priority-${task.priority} ${done ? 'done' : ''}`} onClick={() => onSelect?.(task.id)}>
      <button className={`check ${done ? 'checked' : ''}`} onClick={toggleDone} title={done ? 'Reopen' : 'Complete'}>
        {done ? '✓' : ''}
      </button>
      <div className="task-main">
        <div className="task-title">
          {task.blocked && <span className="badge blocked" title="Waiting on another task">Blocked</span>}
          {task.title}
        </div>
        <div className="task-meta">
          {showProject && task.project_name && (
            <span className="badge project" style={{ '--c': task.project_color }}>{task.project_name}</span>
          )}
          {task.story_title && (
            <span className="badge dev" title={task.epic_title ? `${task.epic_title} › ${task.story_title}` : task.story_title}>
              ⚙ {task.story_title}
            </span>
          )}
          {task.due_date && (
            <span className={`badge due ${overdue ? 'overdue' : ''}`}>due {formatDate(task.due_date)}</span>
          )}
          {task.do_date && !done && <span className="badge">do {formatDate(task.do_date)}</span>}
          {task.estimated_minutes && <span className="badge">{formatEstimate(task.estimated_minutes)}</span>}
          {PRIORITY_LABEL[task.priority] && (
            <span className={`badge priority-${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>
          )}
          {task.subtasks?.length > 0 && <span className="badge">{subDone}/{task.subtasks.length}</span>}
          {task.recurrence && <span className="badge" title="Recurring">↻</span>}
          {task.tags?.map((t) => <span key={t} className="badge tag">#{t}</span>)}
        </div>
      </div>
      {!done && (
        <button className={`myday-toggle ${inMyDay ? 'on' : ''}`} onClick={toggleMyDay}
          title={inMyDay ? 'Remove from My Day' : 'Add to My Day'}>
          <SunIcon width={16} height={16} />
        </button>
      )}
    </div>
  );
}

export default function TaskList({ tasks, empty = 'Nothing here.', ...rowProps }) {
  if (!tasks?.length) return <div className="empty">{empty}</div>;
  return (
    <div className="task-list">
      {tasks.map((t) => <TaskRow key={t.id} task={t} {...rowProps} />)}
    </div>
  );
}
