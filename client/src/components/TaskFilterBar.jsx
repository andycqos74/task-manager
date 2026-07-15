import React from 'react';
import { TASK_SORTS } from '../api.js';

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

// Search + sort + tag/priority filters shared by the flat task-list views
// (All Tasks, Review). Bucketed/curated views (My Day, Upcoming) keep their
// own structure and don't use this.
export default function TaskFilterBar({
  q, onQChange, tags = [], tag, onTagChange, priority, onPriorityChange,
  sort, onSortChange, showDone, onShowDoneChange,
}) {
  return (
    <div className="filters">
      <input className="search-input" placeholder="Search…" value={q} onChange={(e) => onQChange(e.target.value)} />
      <select value={sort} onChange={(e) => onSortChange(e.target.value)}>
        {TASK_SORTS.map(([key, label]) => <option key={key} value={key}>Sort: {label}</option>)}
      </select>
      <select value={priority} onChange={(e) => onPriorityChange(e.target.value)}>
        <option value="">All priorities</option>
        {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
      </select>
      <select value={tag} onChange={(e) => onTagChange(e.target.value)}>
        <option value="">All tags</option>
        {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
      </select>
      <label className="inline">
        <input type="checkbox" checked={showDone} onChange={(e) => onShowDoneChange(e.target.checked)} /> show done
      </label>
    </div>
  );
}
