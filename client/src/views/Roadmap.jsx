import React, { useEffect, useMemo, useState } from 'react';
import { api, DEV_STATUS_LABEL } from '../api.js';

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const DAY = 86400000;
const diffDays = (a, b) => Math.round((parseISO(b) - parseISO(a)) / DAY);

// Epic-level roadmap: one bar per epic (start_date -> target_date), grouped by
// project. Reuses the same clean SVG timeline approach as the task Gantt.
export default function Roadmap({ refreshKey, onError, setView }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/roadmap').then(setData).catch(onError);
  }, [refreshKey]);

  const layout = useMemo(() => {
    if (!data || data.epics.length === 0) return null;
    const dates = data.epics.flatMap((e) => [e.start, e.end]).concat([data.today]);
    const min = dates.reduce((a, b) => (a < b ? a : b));
    const max = dates.reduce((a, b) => (a > b ? a : b));
    const totalDays = Math.max(diffDays(min, max), 1);
    const dayW = totalDays > 180 ? 4 : totalDays > 90 ? 7 : totalDays > 45 ? 12 : 20;
    const pad = 3;
    const rangeStart = parseISO(min);
    rangeStart.setDate(rangeStart.getDate() - pad);
    const startISO = `${rangeStart.getFullYear()}-${String(rangeStart.getMonth() + 1).padStart(2, '0')}-${String(rangeStart.getDate()).padStart(2, '0')}`;
    const days = totalDays + pad + 8;

    const rows = [];
    const groups = new Map();
    for (const e of data.epics) {
      const key = e.project_id ?? 0;
      if (!groups.has(key)) groups.set(key, { name: e.project_name || 'No project', color: e.project_color || 'oklch(70% 0.01 265)', epics: [] });
      groups.get(key).epics.push(e);
    }
    for (const g of groups.values()) {
      rows.push({ type: 'group', label: g.name, color: g.color });
      for (const e of g.epics) rows.push({ type: 'epic', epic: e });
    }
    return { startISO, days, dayW, rows };
  }, [data]);

  if (!data) return <div className="empty">Loading…</div>;

  const rowH = 34;
  const labelW = 220;
  const headerH = 44;

  function bar(e) {
    const x = labelW + diffDays(layout.startISO, e.start) * layout.dayW;
    const w = Math.max((diffDays(e.start, e.end) + 1) * layout.dayW, layout.dayW * 0.8);
    return { x, w };
  }

  return (
    <div className="view wide">
      <header className="view-header">
        <div>
          <h2>Roadmap</h2>
          <div className="subtitle">Epics across dev-enabled projects, by start → target date</div>
        </div>
      </header>

      {!layout ? (
        <div className="empty">
          No dated epics yet. Turn on “Track development” for a project, add epics with start/target dates, and they’ll appear here.
        </div>
      ) : (
        <div className="gantt-scroll">
          <svg
            width={labelW + layout.days * layout.dayW}
            height={headerH + layout.rows.length * rowH + 8}
            className="gantt"
          >
            {Array.from({ length: layout.days }, (_, i) => {
              const d = parseISO(layout.startISO);
              d.setDate(d.getDate() + i);
              const x = labelW + i * layout.dayW;
              const isMonday = d.getDay() === 1;
              const isFirst = d.getDate() === 1;
              const showLabel = layout.dayW >= 18 ? true : isMonday;
              return (
                <g key={i}>
                  <line x1={x} y1={headerH} x2={x} y2={headerH + layout.rows.length * rowH}
                    style={{ stroke: isMonday || isFirst ? 'var(--card-border)' : 'var(--badge-bg)' }} strokeWidth="1" />
                  {(d.getDay() === 0 || d.getDay() === 6) && layout.dayW >= 12 && (
                    <rect x={x} y={headerH} width={layout.dayW} height={layout.rows.length * rowH} style={{ fill: 'var(--badge-bg)' }} />
                  )}
                  {showLabel && layout.dayW >= 12 && (
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
              const e = row.epic;
              const { x, w } = bar(e);
              const done = e.status === 'done' || e.status === 'deployed';
              return (
                <g key={e.id} className="gantt-row" onClick={() => setView({ name: 'project', projectId: e.project_id })}>
                  <rect x={0} y={y} width="100%" height={rowH} fill="transparent" className="gantt-hover" />
                  <text x={24} y={y + rowH / 2 + 4} className={`gantt-label ${done ? 'done' : ''}`}>
                    {e.title.length > 26 ? e.title.slice(0, 25) + '…' : e.title}
                  </text>
                  <rect
                    x={x} y={y + 8} width={w} height={rowH - 16} rx={5}
                    style={{ fill: e.project_color || 'var(--accent)' }} opacity={done ? 0.4 : 0.9}
                  />
                  <text x={x + w + 6} y={y + rowH / 2 + 4} className="gantt-day">{DEV_STATUS_LABEL[e.status] || e.status}</text>
                </g>
              );
            })}

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
