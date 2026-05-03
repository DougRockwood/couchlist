#!/bin/bash
# push.sh — run at the end of a session to push this project + claude config
# usage: ./push.sh ["optional commit message"]
# always pushes both main and myshelf — git no-ops if a branch is unchanged

set -e

# --- Claude config (memories, settings, skills, agents) ---
echo "=== Pushing claude-config ==="
cd /root/.claude
# explicit paths only — skips session churn (history.jsonl, sessions/*.json, projects/*/*.jsonl)
git add -- settings.json agents skills ':(glob)projects/*/memory/**' 2>/dev/null || true
if [ -n "$(git diff --cached --name-only)" ]; then
    git commit -m "sync claude config $(date +%Y-%m-%d)"
fi
git push origin main || echo "  (claude-config main push failed)"

# --- This project ---
echo ""
echo "=== Pushing couchlist ==="
cd /root/projects/couchlist

# stage + commit any uncommitted changes (lands on whichever branch you're currently on)
if [ -n "$(git status --porcelain)" ]; then
    git add -A
    # message priority: CLI arg $1 > interactive prompt > generic datestamp
    msg="${1:-}"
    if [ -z "$msg" ] && [ -t 0 ]; then
        read -p "Commit message (Enter for datestamp): " msg
    fi
    msg="${msg:-sync $(date +%Y-%m-%d)}"
    git commit -m "$msg"
fi

# always push both — git just says "Everything up-to-date" if a branch hasn't moved
git push origin main    || echo "  (main push failed — local main may be behind origin)"
git push origin myshelf || echo "  (myshelf push failed — local myshelf may be behind origin)"

echo ""
echo "All done."
