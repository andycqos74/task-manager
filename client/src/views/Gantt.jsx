import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const DAY = 86400000;
const diffDays = (a, b) => Math.round((parseISO(b) - parseISO(a)) / DAY);

// Clean, minimal SVG Gantt: one row per task, bar spans Do date -> Due date,
// thin connectors for dependencies, red line for today.
export default function Gantt({ refreshKey, projects, onSelectTask, onError }) {
  const [data, setData] = useState(null);
  const [projectFilter, setProjectFilter] = useState('');

  useEffect(() => {
    const qs = projectFilter ? `?project_id=${projectFilter}` : '';
    api.get(`/gantt${qs}`).then(setData).catch(onError);
  }, [refreshKey, projectFilter]);

  const layout = useMemo(() => {
    if (!data || data.tasks.length === 0) return null;
    const dates = data.tasks.flatMap((t) => [t.start, t.end]).concat([data.today]);
    let min = dates.reduce((a, b) => (a < b ? a : b));
    let max = dates.reduce((a, b) => (a > b ? a : b));
    const totalDays = Math.max(diffDays(min, max), 1);
    const dayW = totalDays > 90 ? 8 : totalDays > 45 ? 14 : 24;
    const pad = 3;
    const rangeStart = parseISO(min);
    rangeStart.setDate(rangeStart.getDate() - pad);
    const startISO = `${rangeStart.getFullYear()}-${String(rangeStart.getMonth() + 1).padStart(2, '0')}-${String(rangeStart.getDate()).padStart(2, '0')}`;
    const days = totalDays + pad + 8;

    // Group rows by project, keep dependency lookup by task id.
    const rows = [];
    const groups = new Map();
    for (const t of data.tasks) {
      const key = t.project_id ?? 0;
      if (!groups.has(key)) groups.set(key, { name: t.project_name || 'No project', color: t.project_color || 'oklch(70% 0.01 265)', tasks: [] });
      groups.get(key).tasks.push(t);
    }
    for (const g of groups.values()) {
      rows.push({ type: 'group', label: g.name, color: g.color });
      for (const t of g.tasks) rows.push({ type: 'task', task: t });
    }
    return { startISO, days, dayW, rows };
  }, [data]);

  if (!data) return <div className="empty">Loading…</div>;

  const rowH = 32;
  const labelW = 220;
  const headerH = 44;

  function bar(t) {
    const x = labelW + diffDays(layout.startISO, t.start) * layout.dayW;
    const w = Math.max((diffDays(t.start, t.end) + 1) * layout.dayW, layout.dayW * 0.8);
    return { x, w };
  }

  return (
    <div className="view wide">
      <header className="view-header">
        <div>
          <h2>Timeline</h2>
          <div className="subtitle">Bars run from Do date to Due date; lines show dependencies</div>
        </div>
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </header>

      {!layout ? (
        <div className="empty">No dated tasks to show. Give tasks a Due date (and optionally a Do date) to see them here.</div>
      ) : (
        <div className="gantt-scroll">
          <svg
            width={labelW + layout.days * layout.dayW}
            height={headerH + layout.rows.length * rowH + 8}
            className="gantt"
          >
            {/* day/week grid + date labels */}
            {Array.from({ length: layout.days }, (_, i) => {
              const d = parseISO(layout.startISO);
              d.setDate(d.getDate() + i);
              const x = labelW + i * layout.dayW;
              const isMonday = d.getDay() === 1;
              const isFirst = d.getDate() === 1;
              const showLabel = layout.dayW >= 20 ? true : isMonday;
              return (
                <g key={i}>
                  <line x1={x} y1={headerH} x2={x} y2={headerH + layout.rows.length * rowH}
                    style={{ stroke: isMonday || isFirst ? 'var(--card-border)' : 'var(--badge-bg)' }} strokeWidth="1" />
                  {(d.getDay() === 0 || d.getDay() === 6) && layout.dayW >= 14 && (
                    <rect x={x} y={headerH} width={layout.dayW} height={layout.rows.length * rowH} style={{ fill: 'var(--badge-bg)' }} />
                  )}
                  {showLabel && (
                    <text x={x + 2} y={headerH - 6} className="gantt-day">{d.getDate()}</text>
                  )}
                  {(isFirst || i === 0) && (
                    <text x={x + 2} y={16} className="gantt-month">
                      {d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
                    </text>
                  )}
                </g>
              );
            })}

            {/* rows */}
            {layout.rows.map((row, i) => {
              const y = headerH + i * rowH;
              if (row.type === 'group') {
                return (
                  <g key={`g${i}`}>
                    <rect x={0} y={y} width="100%" height={rowH} style={{ fill: 'var(--badge-bg)' }} />
                    <circle cx={12} cy={y + rowH / 2} r={4} fill={row.color} />
                    <text x={24} y={y + rowH / 2 + 4} className="gantt-group">{row.label}</text>
                  </g>
                );
              }
              const t = row.task;
              const { x, w } = bar(t);
              const done = t.status === 'done';
              return (
                <g key={t.id} className="gantt-row" onClick={() => onSelectTask(t.id)}>
                  <rect x={0} y={y} width="100%" height={rowH} fill="transparent" className="gantt-hover" />
                  <text x={24} y={y + rowH / 2 + 4} className={`gantt-label ${done ? 'done' : ''}`}>
                    {t.title.length > 26 ? t.title.slice(0, 25) + '…' : t.title}
                  </text>
                  <rect
                    x={x} y={y + 7} width={w} height={rowH - 14} rx={5}
                    style={{ fill: t.project_color || 'var(--accent)' }} opacity={done ? 0.3 : 0.85}
                  />
                  {done && <text x={x + w + 6} y={y + rowH / 2 + 4} className="gantt-day">✓</text>}
                </g>
              );
            })}

            {/* dependency connectors */}
            {layout.rows.map((row, i) => {
              if (row.type !== 'task') return null;
              const t = row.task;
              return (t.dependencies || []).map((depId) => {
                const j = layout.rows.findIndex((r) => r.type === 'task' && r.task.id === depId);
                if (j < 0) return null;
                const from = bar(layout.rows[j].task);
                const to = bar(t);
                const y1 = headerH + j * rowH + rowH / 2;
                const y2 = headerH + i * rowH + rowH / 2;
                const x1 = from.x + from.w;
                const x2 = to.x;
                const mid = Math.max(x1 + 8, x2 - 8);
                return (
                  <g key={`${depId}-${t.id}`} className="gantt-dep">
                    <path d={`M ${x1} ${y1} L ${x1 + 8} ${y1} L ${x1 + 8} ${y2} L ${x2 - 4} ${y2}`}
                      fill="none" style={{ stroke: 'var(--text-muted)' }} strokeWidth="1.2" strokeDasharray={x2 <= x1 ? '3 2' : 'none'} />
                    <path d={`M ${x2 - 4} ${y2 - 3} L ${x2 + 1} ${y2} L ${x2 - 4} ${y2 + 3} Z`} style={{ fill: 'var(--text-muted)' }} />
                  </g>
                );
              });
            })}

            {/* today marker */}
            {(() => {
              const x = labelW + diffDays(layout.startISO, data.today) * layout.dayW + layout.dayW / 2;
              return (
                <g>
                  <line x1={x} y1={headerH - 2} x2={x} y2={headerH + layout.rows.length * rowH} style={{ stroke: 'var(--danger)' }} strokeWidth="1.5" />
                  <text x={x + 4} y={headerH - 6} className="gantt-today">today</text>
                </g>
              );
            })()}
          </svg>
        </div>
      )}
    </div>
  );
}
