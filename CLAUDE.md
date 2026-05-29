# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`couchlist.org` — a shared movie voting app for a household or friend group. Phone-first, no accounts, no frameworks. Each list has an 8-char URL; identity is a 10-char cookie. Rankings are combined via Borda count on a "Couch" tab.

Stack: Node.js + Express + `better-sqlite3` on the backend, plain HTML/CSS/vanilla JS on the frontend. TMDB is called directly from the browser (API key is in `public/app.js`). The whole server is one file (~1700 lines on v1.1); the client is one file (~3900 lines on v1.1). Readable "view-source" clarity is a deliberate design goal — no bundler, no build step.

## Commands

```bash
npm install
node server.js                    # http://localhost:3000 (or $PORT)
```

No tests, no linter, no build step. To exercise a change, hit `http://<host>:3000/?ListId=<8-chars>` (or legacy `/<8-chars>`) — that becomes the list ID.

## Two clones, two branches

- `~/projects/couchlist/` is the **main** clone (couchlist.org). In the `sink` ring.
- `~/projects/testCouchlist/` is the **test** clone (test.couchlist.org). NOT in the sink ring — sync manually with `git push origin test` / `git pull --ff-only origin test`.

Each clone is branch-locked. Don't `git checkout` between branches inside a clone.

## Where everything else lives

This repo is intentionally minimal. The deeper context — architecture, deploy details, gotchas, bug history, archived design docs — lives in Doug's private memory at `~/.claude/memory/couchlist/`, indexed by `MEMORY.md` there. When working on this codebase, read those entries on demand:

- **Architecture & schema, API endpoints, Borda algorithm** → `project_architecture.md`
- **Coding gotchas before changing code** (URL params, comment fragility, popup hover, key location) → `coding_gotchas.md`
- **Deploy / droplet / systemd / nginx** → `project_deployment.md` (and `deploy_install_walkthrough.md` for the original phase-1 walkthrough)
- **Branch / clone workflow (post v1.1)** → `rule_branch_workflow.md`
- **TMDB credentials** (current key + history) → `reference_tmdb_keys.md`
- **Bug history** → `project_bughistory.md` (summary), `archive_bugfix_log.md` (full diagnoses)
- **Drag-to-reorder design notes** → `archive_drag_bestpractice.md`, `archive_drag_current.md`
- **Most recent security review** → `security_review_2026-04-25.md`; what shipped → `project_security_validations.md`
- **Original 2026-03 design doc** (mostly stale) → `archive_outline_design_doc.md`
- **Operation WidthPercent visual redesign** → `operation_widthpercent.md`
- **Visual language for cols A/B** → `project_visual_language.md`
- **v1.0 / v1.1 release notes** → `project_v1_1_release.md`
- **Cross-project context (other repos, Doug's profile, sync setup)** → `~/.claude/memory/MEMORY.md` index one level up

## Sync — `sink`

Cross-machine sync is via `sink` (in PATH on both droplet and frannie). The old `pull.sh` / `push.sh` are gone (removed 2026-05-04, commit `4b5890a` in linux-learning). From this clone:
- `sink push` — pulls and pushes every repo in the ring (claude-config + four projects), including this main clone.
- `sink pull` — pulls every repo.

The test clone at `~/projects/testCouchlist/` is **not** in the ring; sync that one with raw git commands.
