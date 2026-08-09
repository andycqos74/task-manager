import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, LEVELS, formatDate } from '../api.js';
import BoardConfig from '../components/BoardConfig.jsx';

const LEVEL_LABEL = { epic: 'Epic', story: 'Story', task: 'Task' };

// Cross-project kanban. Columns come from the board config (each mapped to a
// dev stage); epics, stories and tasks can all be dragged between them.
export default function Kanban({ refreshKey, refresh, projects, onSelectTask, onError }) {
  const [boards, setBoards] = useState([]);
  const [boardId, setBoardId] = useState(null);
  const [cards, setCards] = useState([]);
  const [levels, setLevels] = useState(['epic', 'story', 'task']);
  const [projectFilter, setProjectFilter] = useState('');
  const [q, setQ] = useState('');
  const [swimlane, setSwimlane] = useState('none');
  const [collapsed, setCollapsed] = useState({});
  const [configOpen, setConfigOpen] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const board = boards.find((b) => b.id === boardId) || null;

  const loadBoards = useCallback(() => (
    api.get('/boards').then((bs) => {
      setBoards(bs);
      setBoardId((cur) => (cur && bs.some((b) => b.id === cur) ? cur : (bs[0]?.id ?? null)));
      return bs;
    }).catch(onError)
  ), [onError]);

  useEffect(() => { loadBoards(); }, [loadBoards]);

  const loadCards = useCallback(() => {
    if (!boardId) return;
    const params = new URLSearchParams();
    if (levels.length && levels.length < 3) params.set('levels', levels.join(','));
    if (projectFilter) params.set('project_id', projectFilter);
    if (q) params.set('q', q);
    api.get(`/boards/${boardId}/cards?${params}`).then((d) => setCards(d.cards)).catch(onError);
  }, [boardId, levels, projectFilter, q, onError]);

  useEffect(() => { loadCards(); }, [loadCards, refreshKey]);

  function toggleLevel(key) {
    setLevels((cur) => (cur.includes(key) ? cur.filter((l) => l !== key) : [...cur, key]));
  }

  // Optimistic move, then persist. Revert (by refetching) if the server says no.
  async function moveCard(card, stage) {
    if (card.stage === stage) return;
    const before = cards;
    setCards((cur) => cur.map((c) => (c.type === card.type && c.id === card.id ? { ...c, stage } : c)));
    try {
      await api.post('/kanban/move', { type: card.type, id: card.id, stage });
      refresh();
    } catch (err) {
      setCards(before);
      onError(err);
    }
  }

  const lanes = useMemo(() => buildLanes(cards, swimlane), [cards, swimlane]);

  if (!board) {
    return (
      <div className="view wide">
        <header className="view-header"><div><h2>Boards</h2></div></header>
        <div className="empty">No boards yet.</div>
      </div>
    );
  }

  return (
    <div className="view wide">
      <header className="view-header">
        <div>
          <h2>Boards</h2>
          <div className="subtitle">Drag epics, stories and tasks between stages — across every project</div>
        </div>
        <button className="btn-outline" onClick={() => setConfigOpen(true)}>Configure</button>
      </header>

      <div className="filters">
        <select value={boardId} onChange={(e) => setBoardId(Number(e.target.value))}>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <div className="level-toggle">
          {LEVELS.map(([key, label]) => (
            <button
              key={key}
              className={`level-btn ${levels.includes(key) ? 'on' : ''}`}
              onClick={() => toggleLevel(key)}
            >
              {label}
            </button>
          ))}
          <button className={`level-btn ${levels.length === 3 ? 'on' : ''}`} onClick={() => setLevels(['epic', 'story', 'task'])}>All</button>
        </div>
        <input className="search-input" placeholder="Search cards…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={swimlane} onChange={(e) => setSwimlane(e.target.value)} title="Swimlanes">
          <option value="none">No swimlanes</option>
          <option value="project">Lanes: project</option>
          <option value="epic">Lanes: epic</option>
        </select>
      </div>

      {configOpen && (
        <BoardConfig
          board={board}
          boards={boards}
          onClose={() => setConfigOpen(false)}
          onChanged={() => { loadBoards(); loadCards(); }}
          onSelectBoard={setBoardId}
          onError={onError}
        />
      )}

      {levels.length === 0 ? (
        <div className="empty">No levels selected — pick Epics, Stories or Tasks above.</div>
      ) : (
        lanes.map((lane) => (
          <section key={lane.key} className="kanban-swimlane">
            {swimlane !== 'none' && (
              <h3 className="swimlane-head">
                {lane.color && <span className="dot" style={{ background: lane.color }} />}
                {lane.label} <span className="count">{lane.cards.length}</span>
              </h3>
            )}
            <div className="kanban-board">
              {board.columns.map((col) => {
                const colCards = lane.cards
                  .filter((c) => c.stage === col.stage)
                  .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
                const isCollapsed = !!collapsed[col.id];
                const isDropTarget = dropTarget === `${lane.key}:${col.id}`;
                return (
                  <div
                    key={col.id}
                    className={`kanban-col ${isCollapsed ? 'collapsed' : ''} ${isDropTarget ? 'drag-over' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setDropTarget(`${lane.key}:${col.id}`); }}
                    onDragLeave={() => setDropTarget((t) => (t === `${lane.key}:${col.id}` ? null : t))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropTarget(null);
                      // The dragged card comes from the dataTransfer payload rather
                      // than component state, so a drop is handled correctly even if
                      // React hasn't re-rendered since dragstart.
                      const card = cardFromTransfer(e.dataTransfer, cards) || dragging;
                      if (card) moveCard(card, col.stage);
                      setDragging(null);
                    }}
                  >
                    <div className="kanban-col-head">
                      <button className="col-collapse" onClick={() => setCollapsed((c) => ({ ...c, [col.id]: !c[col.id] }))}>
                        {isCollapsed ? '▸' : '▾'}
                      </button>
                      <span className="col-name">{col.name}</span>
                      <span className="count">{colCards.length}</span>
                    </div>
                    {!isCollapsed && (
                      <>
                        <div className="kanban-cards">
                          {colCards.map((card) => (
                            <KanbanCard
                              key={`${card.type}-${card.id}`}
                              card={card}
                              dragging={dragging && dragging.type === card.type && dragging.id === card.id}
                              onDragStart={() => setDragging(card)}
                              onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                              onOpen={() => card.type === 'task' && onSelectTask(card.id)}
                            />
                          ))}
                          {colCards.length === 0 && <div className="kanban-empty">Drop here</div>}
                        </div>
                        <ColumnAdd
                          stage={col.stage}
                          lane={lane}
                          swimlane={swimlane}
                          levels={levels}
                          projects={projects}
                          onCreated={() => { loadCards(); refresh(); }}
                          onError={onError}
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

// Resolve the "<type>:<id>" payload written on dragstart back to a card.
function cardFromTransfer(dataTransfer, cards) {
  const raw = dataTransfer?.getData('text/plain') || '';
  const [type, id] = raw.split(':');
  if (!type || !id) return null;
  return cards.find((c) => c.type === type && String(c.id) === id) || null;
}

// Group cards into swimlanes (or one implicit lane when off).
function buildLanes(cards, swimlane) {
  if (swimlane === 'none') return [{ key: 'all', label: 'All', cards }];
  const map = new Map();
  for (const c of cards) {
    const key = swimlane === 'project' ? (c.project_id ?? 0) : (c.epic_id ?? 0);
    if (!map.has(key)) {
      map.set(key, {
        key: String(key),
        label: swimlane === 'project'
          ? (c.project_name || 'No project')
          : (c.type === 'epic' ? c.title : c.parent_title || 'No epic'),
        color: swimlane === 'project' ? c.project_color : null,
        projectId: c.project_id,
        epicId: c.epic_id,
        cards: [],
      });
    }
    map.get(key).cards.push(c);
  }
  return [...map.values()];
}

function KanbanCard({ card, dragging, onDragStart, onDragEnd, onOpen }) {
  return (
    <div
      className={`kanban-card level-${card.type} ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `${card.type}:${card.id}`); onDragStart(); }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
    >
      <div className="kanban-card-top">
        <span className={`badge level level-${card.type}`}>{LEVEL_LABEL[card.type]}</span>
        {card.project_name && <span className="badge project" style={{ '--c': card.project_color }}>{card.project_name}</span>}
      </div>
      <div className="kanban-card-title">{card.title}</div>
      {card.parent_title && <div className="kanban-card-parent">↳ {card.parent_title}</div>}
      <div className="kanban-card-meta">
        {card.due_date && <span className="badge">due {formatDate(card.due_date)}</span>}
        {card.target_date && <span className="badge">target {formatDate(card.target_date)}</span>}
        {card.child_count > 0 && <span className="badge">{card.child_count} child{card.child_count > 1 ? 'ren' : ''}</span>}
      </div>
    </div>
  );
}

// In-column quick add. Creates at this column's stage, choosing the level from
// what's visible: tasks are the default; epics need a project; stories need an
// epic, so those only appear when the lane makes the parent unambiguous.
function ColumnAdd({ stage, lane, swimlane, levels, projects, onCreated, onError }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [level, setLevel] = useState(levels.includes('task') ? 'task' : levels[0]);
  const [projectId, setProjectId] = useState('');
  const [epics, setEpics] = useState([]);
  const [epicId, setEpicId] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // Prefill parents from the swimlane when it pins them down.
  useEffect(() => {
    if (swimlane === 'project' && lane.projectId) setProjectId(String(lane.projectId));
    if (swimlane === 'epic' && lane.epicId) setEpicId(String(lane.epicId));
  }, [swimlane, lane.projectId, lane.epicId]);

  useEffect(() => {
    if (level === 'story') {
      const qs = projectId ? `?project_id=${projectId}` : '';
      api.get(`/epics${qs}`).then((es) => {
        setEpics(es);
        setEpicId((cur) => (cur && es.some((e) => String(e.id) === cur) ? cur : (es[0] ? String(es[0].id) : '')));
      }).catch(() => {});
    }
  }, [level, projectId]);

  async function submit(e) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    try {
      if (level === 'epic') {
        if (!projectId) { onError(new Error('Pick a project for the epic')); return; }
        await api.post('/epics', { project_id: Number(projectId), title: t, status: stage });
      } else if (level === 'story') {
        if (!epicId) { onError(new Error('Pick an epic for the story')); return; }
        await api.post('/stories', { epic_id: Number(epicId), title: t, status: stage });
      } else {
        const created = await api.post('/tasks', { title: t, project_id: projectId ? Number(projectId) : null });
        await api.post('/kanban/move', { type: 'task', id: created.id, stage });
      }
      setTitle('');
      setOpen(false);
      onCreated();
    } catch (err) {
      onError(err);
    }
  }

  if (!open) return <button className="col-add" onClick={() => setOpen(true)}>＋ Add</button>;

  return (
    <form className="col-add-form" onSubmit={submit}>
      <input ref={inputRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title…"
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      <select value={level} onChange={(e) => setLevel(e.target.value)}>
        {LEVELS.filter(([k]) => levels.includes(k)).map(([k]) => <option key={k} value={k}>{LEVEL_LABEL[k]}</option>)}
      </select>
      {(level === 'epic' || level === 'task' || level === 'story') && (
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">{level === 'epic' ? 'Pick project…' : 'No project'}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      {level === 'story' && (
        <select value={epicId} onChange={(e) => setEpicId(e.target.value)}>
          {epics.length === 0 && <option value="">No epics</option>}
          {epics.map((ep) => <option key={ep.id} value={ep.id}>{ep.title}</option>)}
        </select>
      )}
      <div className="col-add-actions">
        <button type="submit" className="ai-action-btn">Add</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>cancel</button>
      </div>
    </form>
  );
}
