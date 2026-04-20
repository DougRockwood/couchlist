# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`whatdoyouwannawatch.com` / `couchlist.org` — a shared movie voting app for a household or friend group. Phone-first, no accounts, no frameworks. Each list has an 8-char URL; identity is a 10-char cookie. Rankings are combined via Borda count on a "Couch" tab.

Stack: Node.js + Express + `better-sqlite3` on the backend, plain HTML/CSS/vanilla JS on the frontend. TMDB is called directly from the browser (API key is in `public/app.js`). The whole server is one file (~640 lines); the client is one file (~1600 lines). Readable "view-source" clarity is a deliberate design goal — no bundler, no build step.

## Commands

```bash
npm install                       # first time only
node server.js                    # runs on http://localhost:3000 (or $PORT)
```

There are no tests, no linter, no build step. To exercise a change, hit `http://<host>:3000/<any-8-chars>` — that path becomes the list ID.

Session helpers (for Doug's workflow, not CI):
- `./pull.sh` — syncs `/root/projects/couchlist` and `/root/.claude` from `origin/main`
- `./push.sh` — commits + pushes both repos, prompts for a message

## Deploy

Production is a DigitalOcean droplet (`64.23.204.231`, root) running the code from `/root/projects/couchlist` under systemd as `couchlist.service` on port 3000. Nginx reverse-proxies `couchlist.org` → `:3000` (see `operations/nginx.md` in `linux-learning`).

Ongoing deploys are one command on the droplet:
```bash
bash /root/projects/couchlist/deploy/deploy.sh
```
It's idempotent: fetches, skips if no new commits, runs `npm install` only if `package*.json` changed, then `systemctl restart couchlist`. First-time setup (installing the unit file, clearing port 3000) is in `deploy/INSTALL.md`.

## Architecture — the big picture

The current code is the **flat-redesign** (post-`hail-mary`). The important thing to know about it:

**Rankings and comments live as columns on the `movies` table, not in separate tables.** Each movie row has `user1_rank`, `user1_comment`, …, `user10_rank`, `user10_comment`. A `list_visitors` table maps slot numbers (1–10) to visitor IDs on a per-list basis. This means:

- `GET /api/list/:id` returns one JSON blob that *is* the UI state — no cross-referencing, no reshaping in the client.
- To touch a visitor's data, you look up their slot in `list_visitors`, then build the column name as `'user' + slot + '_rank'` (or `_comment`) and splice it into the SQL. Every endpoint that mutates ranks/comments does this — see sections 8–11 of `server.js`.
- Up to 10 visitors per list is a hard cap baked into the schema.

**Rank invariants every endpoint must preserve:**
- Every occupied slot has a complete, contiguous 1..N ranking with no gaps and no NULLs.
- Adding a movie: adder gets it at rank 1 (everything else bumps down); everyone else gets it at last place.
- Removing a movie: decrement every rank greater than the deleted movie's rank, per slot.
- Joining a list: new visitor's column is initialized with sequential ranks in movie-ID order.

**There is no drag-to-reorder.** Movement is via explicit up/down/top/bottom endpoints (`/swap`, `/move`). The old drag system was ripped out in the flat redesign; don't reintroduce it. See Bug 8 in `bugfix.txt` for the history — on mobile it was deeply broken.

**Identity model.** No accounts. The `wtw_visitor` cookie is a 10-char ID that's the same across every list. The Details modal is how users back up / restore / transplant that ID between browsers. `/api/visitor/:id` DELETE exists solely to recycle a freshly-generated cookie ID when someone pastes an existing one — it only succeeds if the visitor is "untouched" (no name, no slot anywhere). Don't relax that check.

**Frontend structure.** `public/index.html` is a skeleton of named empty containers; `public/app.js` fills all of them via a single `renderList()` / `renderUserTabs()` pass after every state change. State is module-level `let` variables (see Section 2 of `app.js`). Event handling is mostly delegated from a few top-level listeners set up in `setupEventListeners()`. The Borda count for the Couch tab runs entirely in the browser (`calculateCouchRanking`, Section 12) — the server never ranks.

**Name collisions.** Names are stored globally (one per visitor ID). Display names are computed **per-list** in `buildDisplayNames` — the first visitor to interact keeps "Doug", later ones become "Doug(2)" on that list only. Nobody's stored name changes; this is display-only.

## Things to know before changing code

- **Don't re-decode URL params.** Express already URL-decodes `req.params`. Double-decoding crashes on any `%` in a name (Bug 3).
- **TMDB key is client-side** in `public/app.js`. That's intentional for now; there's an open todo to proxy it for open-source forks.
- **Comment collapse is fragile.** Clicking a comment box swaps its innerHTML, which detaches the original click target. Any new outside-click handlers need `stopPropagation` at the comment layer or you'll get Bug 6 again.
- **Movie popup.** It's a hover/long-press overlay. Don't attach hover handlers to search results — that's what caused the sticky-popup Bug 5.
- **No mocking the DB in any tests** if tests ever get added — the app is tiny enough to run against a real SQLite file.
- **Don't use `git add -A`** in commits unless you've checked `git status`; the repo root has `.db`, `.db-shm`, `.db-wal` that should never be committed (they're in `.gitignore`, but still).

## Reference files in the repo

- `Outline.txt` — original design doc. Parts (schema in §3, endpoints in §4) are **stale** — they describe the v1 design with separate `rankings` and `comments` tables. The flat redesign replaced that. Trust `server.js` and the header comments in `app.js`/`server.js` for current schema.
- `bugfix.txt` — 8 bugs found on first live test (2026-04-05) with full diagnoses. Worth skimming before touching drag/comment/popup code even though drag is gone now.
- `docs/drag-*.md` — historical; drag is removed.
- `deploy/INSTALL.md` — systemd install walkthrough (Phase 1 done; Phase 2 pending).

## Cross-project context

This repo is one of Doug's projects on his droplet. Broader context lives outside this directory — glance at these when a question needs it:

- `/root/projects/linux-learning/CLAUDE.md` — admin hub for the droplet; how Doug likes to collaborate, overall environment.
- `/root/projects/linux-learning/examples/DROPLET_CLAUDE.md` — detailed droplet setup notes, original WhatToWatch deployment walkthrough (historical — project has since been renamed to couchlist).
- `/root/.claude/projects/-root-projects-linux-learning/memory/MEMORY.md` — Doug's auto-memory index (user profile, code-style preferences, project catalog, WSL setup). Read the linked memory files for who Doug is and how he likes to work.
