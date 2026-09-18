# Branching, variants and releases

How to develop once and ship to both the personal single-user deployment and the
multi-user one.

## The short version

**Don't fork. Build multi-user into this codebase and make single-user a run mode of it.**

One repository, one test suite, one image, one CI pipeline. The two deployments differ only
by an environment variable:

| | Personal stack | Multi-user stack |
|---|---|---|
| Image | `ghcr.io/andycqos74/task-manager:latest` | the same image |
| `AUTH_MODE` | `single` | `multi` |
| Behaviour | no login screen, exactly as today | email + password login, per-user data |
| Volume | `task-manager-data` | `task-manager-mu-data` |
| Port | 3001 | 3002 (or its own hostname) |

In `AUTH_MODE=single` the server auto-authenticates every request as user #1, which it
creates on first start. Every table still carries `user_id`; it is simply always `1`. The
login screen is skipped. Nothing about the current experience changes.

"Build and test on one branch, then deploy to both" then costs nothing — there is only one
build. You test it, you promote it, both stacks pull the same digest.

## Why not a real fork

The multi-user change is not a feature that sits in its own files. It rewrites the data
access layer:

- every table gains `user_id`
- all 63 endpoints in `server/src/routes.js` gain an ownership filter
- the 26 `activeWorkspaceId()` call sites become per-user state
- `server/src/db.js` schema and migrations change throughout

`routes.js` and `db.js` are also the two files that every *future* feature touches. A fork
would therefore conflict on almost every merge from upstream, forever, and each conflict is
in security-relevant code where a bad resolution silently drops an ownership filter. You
would also be writing every new feature twice and testing it twice.

Two further practical points:

- A GitHub fork of a public repo **cannot be made private**. If the multi-user instance is
  meant to hold other people's data, you would want its repo private — which means a mirror
  push into a fresh repository, not a fork, and you lose the fork's PR-to-upstream
  convenience anyway.
- Two repos means two GHCR packages, two workflow files and two sets of secrets to keep in
  step.

The fork only pays off if the two products genuinely diverge in behaviour. "Same app, one
has logins" is not divergence — it is configuration.

## Branch and release flow (recommended)

```
feature/*  ──PR──▶  develop  ──PR──▶  main
   tests only        :develop          :latest + :main + :sha-<commit>
```

- **`feature/*`** — normal work. CI runs tests and the client build; nothing is published.
- **`develop`** — the integration branch you build and test from. Every push publishes
  `ghcr.io/andycqos74/task-manager:develop`. Point a throwaway stack (or the multi-user
  stack, while it is still settling) at `IMAGE_TAG=develop` to try changes on real Docker
  before they reach `main`.
- **`main`** — what both production stacks run. Every push publishes `:latest`, `:main` and
  an immutable `:sha-<commit>`.
- **`v*` tags** — optional. Tag a known-good commit (`git tag v1.3.0 && git push --tags`)
  to get `:v1.3.0` and `:1.3.0`, and set `IMAGE_TAG=v1.3.0` on the stacks you want frozen.

Promotion is a PR from `develop` to `main`. Deployment is `docker compose pull && docker
compose up -d` on each stack — or the Portainer webhook.

Pin the personal stack to `IMAGE_TAG=v*` if you want it to stop moving while you iterate on
multi-user; leave the multi-user stack on `develop` until it stabilises, then move both to
`latest`.

## Build multi-user on a long-lived branch first

While the auth work is in progress it is a large, half-finished change, and `main` should
keep working. Do it on `multi-user`:

- The publish workflow already treats `multi-user*` as a release ref, so every push there
  produces `ghcr.io/andycqos74/task-manager:multi-user` to test against.
- Rebase or merge `main` into it regularly — while it is one branch in one repo, that is
  cheap and the conflicts are yours, not a permanent tax.
- When `AUTH_MODE=single` passes the existing test suite and the app behaves identically,
  merge `multi-user` into `develop`, then `main`. The branch then disappears and there is
  one line of development again.

That sequencing gives you the isolation a fork would have given you during the risky phase,
without the permanent cost afterwards.

## If you still want two repositories

Set it up as a downstream mirror rather than a GitHub fork, and keep the divergence tiny on
purpose:

1. Create `task-manager-multiuser` (private if it will hold others' data) and push this
   history into it, with this repo added as a remote:
   ```bash
   git remote add upstream https://github.com/andycqos74/task-manager.git
   ```
2. Confine every multi-user change to **new** files — `server/src/auth.js`,
   `server/src/scope.js`, `server/src/crypto.js`, `client/src/views/Login.jsx` — and keep
   the edits to shared files (`routes.js`, `db.js`, `index.js`) to the smallest possible
   hooks. The size of your merge pain is exactly the size of your diff in shared files.
3. Automate the sync with a workflow in the downstream repo that opens a PR instead of
   merging blind:
   ```yaml
   name: Sync from upstream
   on:
     schedule: [{ cron: '0 6 * * 1' }]   # Mondays
     workflow_dispatch:
   jobs:
     sync:
       runs-on: ubuntu-latest
       permissions: { contents: write, pull-requests: write }
       steps:
         - uses: actions/checkout@v4
           with: { fetch-depth: 0 }
         - run: |
             git remote add upstream https://github.com/andycqos74/task-manager.git
             git fetch upstream main
             git checkout -B sync/upstream upstream/main
             git push -f origin sync/upstream
         - run: gh pr create --base main --head sync/upstream
                  --title "Sync from upstream" --body "Automated upstream sync." || true
           env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
   ```
4. Copy `.github/workflows/build.yml` across unchanged — it derives the image name from
   `github.repository`, so the downstream repo publishes its own package automatically.

Expect to resolve conflicts on most syncs once the auth work lands, and to review each one
carefully: a conflict resolved the wrong way in `routes.js` is a data leak between users,
not a compile error.
