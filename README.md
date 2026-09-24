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

Images are built and tested by GitHub Actions and published to GHCR, so the Docker host
never compiles anything — it just pulls:

```bash
curl -O https://raw.githubusercontent.com/andycqos74/task-manager/main/docker-compose.yml
docker compose up -d
```

Then open **http://localhost:3001** in your browser — that one URL serves both the UI and
the API. To enable AI planning, either open **Settings** in the app and paste in a key
(recommended — no restart needed), or put it in a `.env` file beside the compose file
(see `.env.example`).

Update to the newest build, or roll back to an exact commit:

```bash
docker compose pull && docker compose up -d     # newest main
IMAGE_TAG=sha-<commit-sha> docker compose up -d # pin / roll back
```

To build the image locally instead of pulling it (development, or testing a Dockerfile
change):

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build -d
```

The SQLite database is stored in the `task-manager-data` volume (mounted at `/data`, which
the server reads via `DATA_DIR`), so your tasks survive container restarts and image
updates. The image is a three-stage build: it compiles the frontend, compiles the native
`better-sqlite3` module in a toolchain stage, and ships a slim runtime image that runs as a
non-root user.

Full instructions — GHCR package visibility, Portainer, backups, rollbacks — are in
[DEPLOY.md](DEPLOY.md). The design for user accounts is in
[MULTI_USER_PLAN.md](MULTI_USER_PLAN.md).

## User accounts

By default the app runs in **single-user mode**: no sign-in, one implicit
owner, exactly as it has always worked. Set `AUTH_MODE=multi` and the same
build becomes multi-user — email and password sign-in, with each account
getting entirely separate workspaces, projects, tasks, notes, boards, settings
and Anthropic API key. Nothing is shared between accounts.

Multi-user mode requires TLS (the server refuses to start without it) because
it issues a session cookie. See [DEPLOY.md](DEPLOY.md) for the setup, and
[MULTI_USER_PLAN.md](MULTI_USER_PLAN.md) for the design and what is still to
come (MFA, encryption of stored secrets, password reset).

## Concepts

- **Workspaces** — the top level: each keeps its own projects, tasks, notes, ideas, bugs,
  epics/stories and boards, so work and personal stay apart. Switch from the chip in the
  header; settings and the scratch pad are shared. Work can be moved between workspaces —
  a **project** takes its tasks, epics, stories and the ideas, bugs and notes filed against
  it; a **task** can go on its own (it leaves its project and story behind); a **board**
  takes its columns.
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

## Install, offline and notifications

The UI is an installable Progressive Web App. On Android (Chrome) use **Install app** from
the browser menu; on iPhone/iPad use **Share → Add to Home Screen**; on desktop Chrome/Edge
use the install icon in the address bar.

- **Offline** — a service worker (`client/sw.js`, emitted as `/sw.js` by the production
  build) caches the app itself, so it opens with no connection, and keeps the last answer to
  every read, so views you've opened before show their saved data with an "offline" banner.
  Edits need the server, with one exception: **quick-add works offline** — tasks are queued
  on the device and sent when the server is reachable again. Signing out clears the saved
  data and the queue. Dev mode (`npm run dev`) has no service worker, to keep hot reload sane.
- **Notifications** — Settings → Notifications turns on Web Push for that device, and each
  device is turned on separately. The server sends a **daily digest** (overdue, due today,
  My Day) at a time you choose, which defaults to your workday start, and skips days with
  nothing to report. Push needs the app served over **HTTPS** (or `localhost`). On iOS it
  only works when the app is opened from the Home Screen. The server's VAPID keys are
  generated on first use and stored in the database. To pin them yourself, set
  `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`. A public instance should set `VAPID_SUBJECT` to a
  `mailto:` or `https:` contact.
- **Timezone** — "today", and so the digest time, follow the server's clock. In Docker that
  is UTC unless you set `TZ` (e.g. `TZ=Europe/London`).

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
  index.js          starts the server
  src/app.js        builds the express app (exported so tests drive the real one)
  src/auth.js       passwords, sessions, AUTH_MODE, the auth middleware
  src/auth-routes.js  /api/auth/... — setup, login, logout, password, sessions
  src/scope.js      per-request scope: whose data this request may touch
  src/routes.js     REST API (/api/...) — validation and orchestration, no SQL
  src/data/*.js     every query, each one filtered by the request scope
  src/db.js         schema + migrations
  src/dates.js    date maths incl. the Do-date default rule
  src/scoring.js  rule-based ranking / fallback planner
  src/ai.js       Claude API integration
client/   React + Vite, no UI framework (styling is a deliberate later pass)
```

The split between `routes.js` and `src/data/` is load-bearing rather than
cosmetic: an accessor cannot be called without a scope, so an endpoint cannot
read or write a row outside the caller's reach even if the handler forgets to
check. Ownership is recorded in exactly one column — `workspaces.user_id` — and
`src/scope.js` proves on every request that the active workspace belongs to the
caller, which is what lets every other query filter on the workspace alone.

`test/cross-scope.js` holds one table of refusal cases that two suites run:
`isolation.test.js` against two workspaces, `user-isolation.test.js` against two
accounts. So an endpoint that is safe against a workspace switch but not against
a different person cannot pass one and fail silently in the other.

Run server unit tests with `npm test`.

## API sketch

- `GET/POST /api/workspaces`, `PATCH/DELETE /api/workspaces/:id`,
  `POST /api/workspaces/:id/activate`
- `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`
- `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id` (quick add = `{title}` only)
- `POST /api/projects/:id/move`, `POST /api/tasks/:id/move`, `POST /api/boards/:id/move`
  `{workspace_id}` — move between workspaces (a task also takes an optional `project_id`
  naming a project in the destination)
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
