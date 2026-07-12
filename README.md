# Task Manager

A web-based task management system built around quick capture, projects/goals, a "My Day"
workflow, rolling day/week planning, a clean Gantt timeline, and (optional) Claude-powered
planning and prioritisation.

## Quick start

```bash
npm run install:all   # installs server + client dependencies
npm run dev           # API on :3001, UI on :5173 (with hot reload)
```

Production style (single server, serves the built UI):

```bash
npm run install:all
npm run build
npm start             # everything on http://localhost:3001
```

Optional AI planning — set an Anthropic API key before starting the server:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Without a key the app still works: "Plan my day" and "Prioritise" fall back to a built-in
rule engine (deadlines, start dates, priority, dependencies, workload).

## Concepts

- **Projects / Goals** — larger pieces of work. Tasks can belong to a project or live in
  the general pool. Projects track status, start/target dates and completion progress.
- **Quick capture** — every view has a one-line add box: type a title, press Enter. All
  other detail (dates, estimate, notes, checklist, tags, dependencies, recurrence) can be
  added later in the task panel.
- **Three dates per task**:
  - **Due date** — when it must be finished.
  - **Do date** — when the work should start. Defaults to `Due date − Estimated TTC`
    (rounded up to whole workdays, workday length configurable in Settings). Editing the
    Do date makes it manual; a one-click "reset" returns it to automatic.
  - **Estimated TTC** — estimated time to complete, entered as `2h`, `90m`, `1d 4h`, etc.
- **My Day** — like Microsoft To Do's My Day. Shows tasks flagged for today (one click on
  the ☀ icon, flag expires at midnight) plus tasks whose Do date has arrived. Includes
  overdue and workload warnings (planned estimates vs. workday length).
- **Upcoming** — rolling view bucketed by Do date: Overdue, Do today, Do tomorrow, This
  week, Next week, Later, No date.
- **Timeline** — minimal SVG Gantt. Bars run from Do date to Due date, grouped by project,
  with dependency connectors and a today line.
- **Dependencies** — tasks can depend on other tasks; blocked tasks are labelled, sink in
  ranking, and are never suggested for today. Cycles are rejected.
- **Extras** — subtask checklists, tags with search/filter, recurring tasks
  (daily/weekly/monthly — completing one spawns the next occurrence).

## AI integration

`server/src/ai.js` calls the Claude API (`claude-opus-4-8` by default, override with
`CLAUDE_MODEL`) using structured JSON output:

- `POST /api/ai/plan-day` — picks a realistic set of tasks for today with reasons.
- `POST /api/ai/prioritise` — ranks all open tasks with a reason per task.

Both endpoints degrade to the rule-based engine in `server/src/scoring.js` when no key is
configured or a call fails.

## Architecture

```
server/   Express + better-sqlite3 (data in server/data/tasks.db)
  src/db.js       schema + settings
  src/dates.js    date maths incl. the Do-date default rule
  src/scoring.js  rule-based ranking / fallback planner
  src/ai.js       Claude API integration
  src/routes.js   REST API (/api/...)
client/   React + Vite, no UI framework (styling is a deliberate later pass)
```

Run server unit tests with `npm test`.

## API sketch

- `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`
- `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id` (quick add = `{title}` only)
- `POST /api/tasks/:id/my-day` `{on: true|false}`
- `POST /api/tasks/:id/subtasks`, `PATCH/DELETE /api/subtasks/:id`
- `PUT /api/tasks/:id/dependencies` `{depends_on_ids: [...]}`
- `GET /api/views/my-day`, `GET /api/views/schedule`, `GET /api/gantt`
- `GET /api/tags`, `GET/PATCH /api/settings`
- `GET /api/ai/status`, `POST /api/ai/plan-day`, `POST /api/ai/prioritise`

The schema is single-user but auth-ready: adding a `user_id` column to `projects`/`tasks`
and a session layer is the intended path to multi-user.
