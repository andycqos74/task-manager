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
```

If you already have the repo:

```bash
git checkout main
git pull
```

All deployment now tracks `main` — there is no separate feature branch to check out.

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

The SQLite database lives in a **named Docker volume** called `task-manager-data` (mounted
at `/data`), so all projects, tasks and notes survive restarts, rebuilds, and
`docker compose down`. The name is pinned in `docker-compose.yml` (rather than left to
Compose's default `<project>_taskdata` derivation), so it stays the same volume no matter
what the Compose project or Portainer stack is named — redeploying under a different stack
name will not silently start you on an empty database.

Back up:

```bash
docker run --rm -v task-manager-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/taskdata-backup.tar.gz -C /data .
```

Restore:

```bash
docker run --rm -v task-manager-data:/data -v "$PWD":/backup alpine \
  sh -c "cd /data && tar xzf /backup/taskdata-backup.tar.gz"
```

> ⚠️ Only `docker compose down -v` (with `-v`) deletes the volume and wipes your data.
> Do not use that flag unless you intend to start completely fresh.

## Without Compose (equivalent)

```bash
docker build -t task-manager .
docker run -d --name task-manager -p 3001:3001 \
  -v task-manager-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-your-key-here \   # optional — can also be set later in Settings
  --restart unless-stopped task-manager
```

## Deploying via Portainer

The most robust way to run this in Portainer is a **Stack deployed from the Git repository**
(not by pasting the compose file into the web editor) — that gives you a one-click,
reliable way to pull new commits and rebuild, instead of relying on stale files sitting on
the Portainer host.

1. **Portainer → Stacks → Add stack**
2. Name it (e.g. `task-manager`) — the name doesn't affect data persistence since the
   volume name is pinned in `docker-compose.yml`.
3. Build method: **Repository**
   - Repository URL: `https://github.com/andycqos74/task-manager.git`
   - Repository reference: `refs/heads/main`
   - Compose path: `docker-compose.yml`
4. (Optional) Environment variables: `ANTHROPIC_API_KEY` — or skip this and add the key
   later in the app's **Settings** page instead, which needs no redeploy.
5. **Deploy the stack.**

**To update after new commits land on `main`:**
- Open the stack → **Pull and redeploy**. This is the step that actually re-fetches the
  branch before rebuilding — a plain "restart" or a build without this step reuses whatever
  source was last pulled, which is the most common cause of "I rebuilt but nothing changed."
- For hands-off updates, open the stack → **Webhooks** → enable, then trigger the webhook
  URL after a push (manually with `curl -X POST <url>`, or wire it into a GitHub Action).

**To verify a redeploy actually picked up new code**, check that the API reflects the
current schema — e.g. after the AI-key-in-Settings change, `/api/settings` gained
`ai_key_source` and `ai_key_last4` fields:

```bash
curl -s http://YOUR_HOST:3001/api/settings
```

If a field you expect from a recent change is missing, the stack rebuilt from stale source
— re-check step "Pull and redeploy" above rather than rebuilding again with the same source.

## Notes

- These steps serve the app over **plain HTTP on port 3001**, which is fine for local or
  trusted-network use. If you expose it on the public internet, put it behind a reverse
  proxy (Caddy / nginx / Traefik) to terminate TLS.
- The database schema is created automatically on first start; there is no separate
  migration step.
