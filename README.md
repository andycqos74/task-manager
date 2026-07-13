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

Optional AI planning — add a key in the app's **Settings** page (stored in the database, no
restart needed), or set it before starting the server:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

A key entered in Settings takes precedence over the environment variable. Without either,
the app still works: "Plan my day" and "Prioritise" fall back to a built-in rule engine
(deadlines, start dates, priority, dependencies, workload).

## Run with Docker

The whole app runs as a **single container** — the Node server serves the built React
frontend and the `/api` routes on the same port, so there is no separate web server and
no CORS to configure.

```bash
docker compose up --build
```

Then open **http://localhost:3001** in your browser — that one URL serves both the UI and
the API. To enable AI planning, either open **Settings** in the app and paste in a key
(recommended — no restart needed), or provide it as an environment variable before starting
the container:

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up --build
```

Without Compose:

```bash
docker build -t task-manager .
docker run -p 3001:3001 -v taskdata:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... task-manager   # -e is optional
```

The SQLite database is stored in the `taskdata` volume (mounted at `/data`, which the
server reads via `DATA_DIR`), so your tasks survive container restarts and rebuilds. The
image is a three-stage build: it compiles the frontend, compiles the native `better-sqlite3`
module in a toolchain stage, and ships a slim runtime image that runs as a non-root user.

## Concepts

- **Projects / Goals** — larger pieces of work. Tasks can belong to a project or live in
  the general pool. Projects track status, start/target dates and completion progress.
- **Quick capture** — every view has a one-line add box: type a title, press Enter. All
  other detail (dates, estimate, notes, checklist, tags, dependencies, recurrence) can be
  added later in the task panel.
- **Three dates per task**:
  - **Due date** — when it must be finished.
  - **Do date** — when the work should start. Defaults to `Due date − Estimated TTC`. The
    due date itself counts as a working day, so a task that fits within one workday starts
    on its due date; only whole extra workdays push the start earlier (workday length is
    configurable in Settings). Editing the Do date makes it manual; a one-click "reset"
    returns it to automatic.
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
- **Notepad** — an always-visible scratch pad docked at the bottom, on ruled paper. Like
  OneNote/a paper pad, **click anywhere on the page to start a separate note block** where
  you clicked (jot document notes in one spot, a phone-call note in another); blocks can be
  dragged to reposition. **Resizable** — drag the handle above the notepad, or use the
  "Expand/Shrink" button for a quick big/small toggle; the size is remembered. Everything
  auto-saves. A note can be **standalone** or **attached** to a single task or project, and
  any **line or selection can be turned into a task** with one click (first line → title,
  the rest → task notes). A singleton "Scratch" note is always present; use "＋ New" for
  additional pages.
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
- `GET/POST /api/notes`, `GET /api/notes/scratch`, `GET/PATCH/DELETE /api/notes/:id`
  (attach via `{task_id}` or `{project_id}`; a note has at most one owner)
- `GET /api/tags`, `GET/PATCH /api/settings`
- `GET /api/ai/status`, `POST /api/ai/plan-day`, `POST /api/ai/prioritise`

The schema is single-user but auth-ready: adding a `user_id` column to `projects`/`tasks`
and a session layer is the intended path to multi-user.
