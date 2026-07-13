# Deployment Guide (Docker)

The app runs as a **single container** — the Node server serves both the React UI and the
`/api` routes on one port, so there is nothing else to stand up (no separate frontend
server, no nginx, no CORS).

## Prerequisites

- Docker Engine + Docker Compose v2 on the target machine:
  ```bash
  docker --version
  docker compose version
  ```
- Outbound internet **at build time** (to pull `node:22-slim` and npm packages). Once the
  image is built, running it needs no internet unless you use the AI features.

## 1. Get the code

```bash
git clone https://github.com/andycqos74/task-manager.git
cd task-manager
git checkout claude/task-management-system-7pco4a
```

If you already have the repo:

```bash
git fetch origin
git checkout claude/task-management-system-7pco4a
git pull
```

## 2. (Optional) Add your Anthropic API key

Two ways to provide it — a key entered in the app takes precedence if both are set:

- **In the app (recommended)** — after starting the container (step 3), open the app →
  **Settings** → paste the key under "Claude API key" → Save. It's stored in the app's
  database, masked after saving, and can be changed any time with no restart or redeploy.
- **As an environment variable** — create a `.env` file next to `docker-compose.yml` before
  starting the container. Compose loads it automatically, and `.env` is gitignored so it is
  never committed:

  ```bash
  echo 'ANTHROPIC_API_KEY=sk-ant-your-key-here' > .env
  ```

Without either, the app still works fully — "Plan my day" and "Prioritise" fall back to the
built-in rule engine (deadlines, start dates, priority, dependencies, workload). Optionally
set `CLAUDE_MODEL` in `.env` to override the default (`claude-opus-4-8`).

## 3. Build and start

```bash
docker compose up --build -d
```

`--build` compiles the image (frontend build → native `better-sqlite3` compile → slim
runtime); `-d` runs it in the background. The first build takes a few minutes; later
starts are instant.

## 4. Access it

Open **http://localhost:3001** — that one URL serves both the UI and the API.

- Remote server: browse to `http://SERVER_IP:3001` and open port 3001 in the
  firewall / security group.
- Different host port: edit the `ports` line in `docker-compose.yml`, e.g.
  `"8080:3001"`, then re-run step 3 and browse to `:8080`.

## 5. Verify

```bash
docker compose ps                            # service should be "running"
curl -s http://localhost:3001/api/settings   # -> {"workday_minutes":480,...,"ai_available":true|false}
```

`ai_available` confirms whether your API key was picked up.

## Day-2 operations

Logs:

```bash
docker compose logs -f
```

Stop / start / restart:

```bash
docker compose stop
docker compose start
docker compose restart
```

Update to the latest code (data is preserved):

```bash
git pull
docker compose up --build -d
```

Tear down but keep data:

```bash
docker compose down      # removes the container, NOT the volume
```

## Data persistence & backup

The SQLite database lives in a **named Docker volume** called `taskdata` (mounted at
`/data`), so all projects, tasks and notes survive restarts, rebuilds, and
`docker compose down`.

Back up:

```bash
docker run --rm -v task-manager_taskdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/taskdata-backup.tar.gz -C /data .
```

Restore:

```bash
docker run --rm -v task-manager_taskdata:/data -v "$PWD":/backup alpine \
  sh -c "cd /data && tar xzf /backup/taskdata-backup.tar.gz"
```

> ⚠️ Only `docker compose down -v` (with `-v`) deletes the volume and wipes your data.
> Do not use that flag unless you intend to start completely fresh.

## Without Compose (equivalent)

```bash
docker build -t task-manager .
docker run -d --name task-manager -p 3001:3001 \
  -v taskdata:/data \
  -e ANTHROPIC_API_KEY=sk-ant-your-key-here \   # optional
  --restart unless-stopped task-manager
```

## Notes

- These steps serve the app over **plain HTTP on port 3001**, which is fine for local or
  trusted-network use. If you expose it on the public internet, put it behind a reverse
  proxy (Caddy / nginx / Traefik) to terminate TLS.
- The database schema is created automatically on first start; there is no separate
  migration step.
