# Deployment Guide (Docker)

The app runs as a **single container** — the Node server serves both the React UI and the
`/api` routes on one port, so there is nothing else to stand up (no separate frontend
server, no nginx, no CORS).

**Images are built by GitHub, not by the Docker host.** Every push to `main` runs the tests
and publishes a ready-made image to the GitHub Container Registry (GHCR). The host only
pulls it. That means no build toolchain, no npm install and no multi-minute
`better-sqlite3` compile on the server — a deploy is a pull and a restart.

| | Old (build on host) | Now (build on GitHub) |
|---|---|---|
| Deploy time | minutes (full rebuild) | seconds (pull) |
| Host needs | build tools, npm registry access | Docker + GHCR access |
| Broken build found | on the server, mid-deploy | in CI, before it ships |
| Rollback | rebuild an old commit | point at an older tag |

## Prerequisites

- Docker Engine + Docker Compose v2 on the target machine:
  ```bash
  docker --version
  docker compose version
  ```
- Outbound access to `ghcr.io`. (The AI features also need outbound internet at runtime;
  everything else works offline once the image is pulled.)

## 0. One-time: make the image pullable

The first workflow run creates the package `ghcr.io/andycqos74/task-manager`. **GHCR
packages start private even when the repository is public**, so do one of these once:

- **Make it public (simplest).** GitHub → your profile → **Packages** → `task-manager` →
  **Package settings** → **Change visibility → Public**. The Docker host then pulls with no
  credentials at all. Also link it to the repo under **Manage Actions access** if you want
  it to show on the repo page.
- **Keep it private.** Create a PAT with the `read:packages` scope and log in on the host
  once — the credential is stored in `~/.docker/config.json` and survives reboots:
  ```bash
  echo "$GHCR_PAT" | docker login ghcr.io -u andycqos74 --password-stdin
  ```
  In Portainer, add the same as a **Registry** (Registries → Add registry → Custom →
  `ghcr.io`) and select it on the stack.

## 1. Put the compose file on the host

You do **not** need the source tree any more — only `docker-compose.yml` and, optionally,
a `.env`:

```bash
mkdir -p ~/task-manager && cd ~/task-manager
curl -O https://raw.githubusercontent.com/andycqos74/task-manager/main/docker-compose.yml
```

(Cloning the repo also works and keeps `.env.example` handy; nothing in the checkout is
used for building.)

## 2. (Optional) Configure

Copy `.env.example` to `.env` next to `docker-compose.yml` — Compose loads it
automatically, and `.env` is gitignored so it is never committed.

```bash
# which build to run: latest (default) | main | multi-user | v1.2.0 | sha-<commit>
IMAGE_TAG=latest
HOST_PORT=3001
ANTHROPIC_API_KEY=sk-ant-your-key-here   # optional
```

The Anthropic key can also be entered in the app (**Settings → Claude API key**), which
takes precedence and needs no restart. Without either, "Plan my day" and "Prioritise" fall
back to the built-in rule engine.

## 3. Start

```bash
docker compose up -d
```

First start pulls the image (tens of seconds); later ones are instant.

## 4. Access it

Open **http://localhost:3001** — that one URL serves both the UI and the API.

- Remote server: browse to `http://SERVER_IP:3001` and open the port in the firewall.
- Different host port: set `HOST_PORT=8080` in `.env` and re-run step 3.

## 5. Verify

```bash
docker compose ps                            # service should be "running"
curl -s http://localhost:3001/api/settings   # -> {"workday_minutes":480,...,"ai_available":true|false}
docker compose images                        # shows the exact image tag in use
```

## Updating

Because the image is built upstream, updating no longer involves `git pull` or `--build`:

```bash
docker compose pull && docker compose up -d
```

That re-fetches whatever `IMAGE_TAG` points at (default `latest` = newest `main`) and
recreates the container. Data is untouched — it lives in the volume.

### Rolling back

Every build is also tagged with its exact commit, so a rollback is a one-line change:

```bash
IMAGE_TAG=sha-<40-char-commit-sha> docker compose up -d
```

Find the sha in the Actions run summary, on the commit in GitHub, or under the repo's
**Packages** page. Put it in `.env` to make it stick.

## Day-2 operations

```bash
docker compose logs -f          # logs
docker compose restart          # restart
docker compose down             # remove the container, NOT the volume
```

## Data persistence & backup

The SQLite database lives in a **named Docker volume** called `task-manager-data` (mounted
at `/data`), so everything survives restarts, image updates and `docker compose down`. The
name is pinned in `docker-compose.yml` rather than derived from the stack name, so
redeploying under a different Portainer stack name will not silently start you on an empty
database.

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

## Deploying via Portainer

Portainer no longer needs to build anything, which removes the most common failure mode
(a stack rebuilding from stale, previously-pulled source).

1. **Portainer → Stacks → Add stack**
2. Name it (e.g. `task-manager`). The name does not affect data persistence — the volume
   name is pinned.
3. Build method: **Repository**
   - Repository URL: `https://github.com/andycqos74/task-manager.git`
   - Repository reference: `refs/heads/main`
   - Compose path: `docker-compose.yml`
4. (Optional) Environment variables: `IMAGE_TAG`, `HOST_PORT`, `ANTHROPIC_API_KEY`.
5. (If the GHCR package is private) select the `ghcr.io` registry you added in step 0.
6. **Deploy the stack.**

**To update:** open the stack → **Pull and redeploy**, with **Re-pull image** enabled. The
compose file also sets `pull_policy: always`, so the new image is fetched even if Portainer
reuses a cached one.

For hands-off updates, enable the stack's **Webhook** and have the publish workflow call it
after a successful push — add the URL as a repository secret (e.g. `PORTAINER_WEBHOOK`) and
a final step to `.github/workflows/build.yml`:

```yaml
      - name: Trigger Portainer redeploy
        if: github.ref == 'refs/heads/main'
        run: curl -fsS -X POST "${{ secrets.PORTAINER_WEBHOOK }}"
```

(Only add that if Portainer is reachable from GitHub's runners. If it is on a private
network, use Watchtower on the host instead, or keep redeploying by hand.)

## Building on the host anyway

Still supported, for local development or for testing a Dockerfile change before merging:

```bash
git clone https://github.com/andycqos74/task-manager.git && cd task-manager
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build -d
```

That override replaces the GHCR image with a locally built `task-manager:local`.

## Notes

- **Architecture:** published images are `linux/amd64`. On an arm64 host (Raspberry Pi 4/5,
  Apple silicon, AWS Graviton) either build locally with the override above, or add
  `linux/arm64` to `platforms:` in `.github/workflows/build.yml` — note that emulated
  cross-compilation of the native `better-sqlite3` module is slow, so prefer an
  `ubuntu-24.04-arm` runner in a build matrix.
- These steps serve the app over **plain HTTP on port 3001**, which is fine on a trusted
  network. Behind a public address, put it behind a reverse proxy (Caddy / nginx / Traefik)
  for TLS. This becomes mandatory once user accounts land — see `MULTI_USER_PLAN.md`.
- The database schema is created automatically on first start; there is no migration step.
