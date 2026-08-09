import React, { useState } from 'react';
import { api, DEV_STATUSES } from '../api.js';

// Board + column editor, shown as an overlay panel over the board. Columns are
// the configurable part: name, which dev stage they map to, and their order.
export default function BoardConfig({ board, boards, onClose, onChanged, onSelectBoard, onError }) {
  const [newBoard, setNewBoard] = useState('');
  const [newCol, setNewCol] = useState('');
  const [newColStage, setNewColStage] = useState('backlog');

  const run = (p) => p.then(() => onChanged()).catch(onError);

  async function addBoard(e) {
    e.preventDefault();
    const name = newBoard.trim();
    if (!name) return;
    try {
      const created = await api.post('/boards', { name });
      setNewBoard('');
      onChanged();
      onSelectBoard(created.id);
    } catch (err) { onError(err); }
  }

  function removeBoard() {
    if (boards.length <= 1) { onError(new Error('Keep at least one board')); return; }
    if (!confirm(`Delete board "${board.name}"? Its columns are removed; cards are untouched.`)) return;
    run(api.delete(`/boards/${board.id}`));
  }

  function addColumn(e) {
    e.preventDefault();
    const name = newCol.trim();
    if (!name) return;
    run(api.post(`/boards/${board.id}/columns`, { name, stage: newColStage })).then(() => setNewCol(''));
  }

  function moveColumn(col, delta) {
    const ordered = [...board.columns];
    const i = ordered.findIndex((c) => c.id === col.id);
    const j = i + delta;
    if (j < 0 || j >= ordered.length) return;
    // Swap the two columns' sort_order values.
    run(Promise.all([
      api.patch(`/board-columns/${ordered[i].id}`, { sort_order: j }),
      api.patch(`/board-columns/${ordered[j].id}`, { sort_order: i }),
    ]));
  }

  function removeColumn(col) {
    if (board.columns.length <= 1) { onError(new Error('Keep at least one column')); return; }
    if (!confirm(`Delete column "${col.name}"? Cards in it stay at stage "${col.stage}".`)) return;
    run(api.delete(`/board-columns/${col.id}`));
  }

  return (
    <>
      <div className="detail-backdrop" onClick={onClose} />
      <aside className="detail-panel board-config" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <strong>Configure board</strong>
          <button className="link" onClick={onClose}>Close ✕</button>
        </div>

        <label className="section-label">Board name</label>
        <input
          className="detail-title"
          key={`bn-${board.id}-${board.updated_at}`}
          defaultValue={board.name}
          onBlur={(e) => e.target.value.trim() && e.target.value !== board.name && run(api.patch(`/boards/${board.id}`, { name: e.target.value }))}
        />

        <label className="section-label">Columns</label>
        <div className="col-config-list">
          {board.columns.map((col, i) => (
            <div key={col.id} className="col-config-row">
              <input
                key={`cn-${col.id}-${col.updated_at}`}
                defaultValue={col.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== col.name && run(api.patch(`/board-columns/${col.id}`, { name: e.target.value }))}
              />
              <select value={col.stage} onChange={(e) => run(api.patch(`/board-columns/${col.id}`, { stage: e.target.value }))}>
                {DEV_STATUSES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <button className="link" disabled={i === 0} onClick={() => moveColumn(col, -1)} title="Move left">←</button>
              <button className="link" disabled={i === board.columns.length - 1} onClick={() => moveColumn(col, 1)} title="Move right">→</button>
              <button className="link danger-link" onClick={() => removeColumn(col)} title="Delete column">✕</button>
            </div>
          ))}
        </div>

        <form className="col-config-add" onSubmit={addColumn}>
          <input value={newCol} onChange={(e) => setNewCol(e.target.value)} placeholder="New column name" />
          <select value={newColStage} onChange={(e) => setNewColStage(e.target.value)}>
            {DEV_STATUSES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <button type="submit" className="btn-outline">Add column</button>
        </form>

        <label className="section-label">Boards</label>
        <div className="col-config-list">
          {boards.map((b) => (
            <div key={b.id} className="col-config-row">
              <button className={`link ${b.id === board.id ? 'active-board' : ''}`} onClick={() => onSelectBoard(b.id)}>
                {b.id === board.id ? '● ' : '○ '}{b.name}
              </button>
            </div>
          ))}
        </div>
        <form className="col-config-add" onSubmit={addBoard}>
          <input value={newBoard} onChange={(e) => setNewBoard(e.target.value)} placeholder="New board name" />
          <button type="submit" className="btn-outline">Add board</button>
        </form>

        <div className="detail-footer">
          <button className="danger" onClick={removeBoard}>Delete this board</button>
        </div>
      </aside>
    </>
  );
}
