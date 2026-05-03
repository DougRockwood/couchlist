#!/bin/bash
# push.sh — run at the end of a session to push this project + claude config
# usage: ./push.sh ["optional commit message"]

set -e

# helper: true when HEAD is ahead of origin/main (unpushed commits exist)
ahead_of_origin() {
    git fetch origin main --quiet 2>/dev/null || true
    [ "$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)" -gt 0 ]
}

# --- Claude config (memories, settings, skills, agents) ---
echo "=== Pushing claude-config ==="
cd /root/.claude
# explicit paths only — skips session churn (history.jsonl, sessions/*.json, projects/*/*.jsonl)
git add -- settings.json agents skills ':(glob)projects/*/memory/**' 2>/dev/null || true
if [ -n "$(git diff --cached --name-only)" ]; then
    git commit -m "sync claude config $(date +%Y-%m-%d)"
fi
if ahead_of_origin; then
    git push origin main
    echo "Claude config pushed."
else
    echo "No claude-config changes to push."
fi

# --- This project ---
echo ""
echo "=== Pushing couchlist ==="
cd /root/projects/couchlist
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
if ahead_of_origin; then
    git push origin main
    echo "couchlist pushed."
else
    echo "No couchlist changes to push."
fi

echo ""
echo "All done."
