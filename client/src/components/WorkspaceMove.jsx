import React, { useState } from 'react';

// Shared "move to another workspace" control: a workspace picker showing where
// the thing lives now. Picking a different workspace calls onMove(id), which
// owns the confirmation and the API call — what travels along differs per
// entity (a project takes its whole tree, a task travels alone).
export default function WorkspaceMove({ workspaces, currentId, onMove, hint }) {
  const [busy, setBusy] = useState(false);

  if (!workspaces || workspaces.length < 2) {
    return <span className="hint">Add a second workspace in Settings to move this.</span>;
  }

  async function pick(e) {
    const id = Number(e.target.value);
    if (!id || id === currentId) return;
    setBusy(true);
    try {
      await onMove(id);
    } finally {
      setBusy(false); // a refused move leaves currentId alone, so the select snaps back
    }
  }

  return (
    <div className="ws-move">
      <select value={currentId ?? ''} disabled={busy} onChange={pick}>
        {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
