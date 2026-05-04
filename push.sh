#!/bin/bash
# push.sh — sync this clone (any branch) and claude-config to origin.
# Generic: works from any couchlist clone, pushes whatever branch is checked
# out. Picks up the clone's own directory via $BASH_SOURCE so it doesn't
# matter where you invoke it from.
#
# usage: ./push.sh ["optional commit message"]

set -e

# Capture this clone's directory NOW, before any `cd` below — using
# BASH_SOURCE after a cd would resolve a relative invocation against the
# wrong directory and treat /root/.claude as the project clone.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# helper: true when HEAD is ahead of origin/<branch>
ahead_of_origin() {
    local b="$1"
    git fetch origin "$b" --quiet 2>/dev/null || true
    [ "$(git rev-list --count origin/$b..HEAD 2>/dev/null || echo 0)" -gt 0 ]
}

# --- Claude config (always on main) — only sync if it exists locally ---
if [ -d /root/.claude ]; then
    echo "=== Pushing claude-config ==="
    cd /root/.claude
    # explicit paths only — skips session churn (history.jsonl, sessions/*.json, projects/*/*.jsonl)
    git add -- settings.json agents skills ':(glob)projects/*/memory/**' 2>/dev/null || true
    if [ -n "$(git diff --cached --name-only)" ]; then
        git commit -m "sync claude config $(date +%Y-%m-%d)"
    fi
    if ahead_of_origin main; then
        git push origin main
        echo "Claude config pushed."
    else
        echo "No claude-config changes to push."
    fi
    echo ""
fi

# --- This couchlist clone — current branch, current path ---
cd "$SCRIPT_DIR"
BRANCH="$(git branch --show-current)"
NAME="$(basename "$SCRIPT_DIR")"

echo "=== Pushing $NAME (branch: $BRANCH) ==="
if [ -n "$(git status --porcelain)" ]; then
    git add -A
    msg="${1:-}"
    if [ -z "$msg" ] && [ -t 0 ]; then
        read -p "Commit message (Enter for datestamp): " msg
    fi
    msg="${msg:-sync $(date +%Y-%m-%d)}"
    git commit -m "$msg"
fi
if ahead_of_origin "$BRANCH"; then
    git push origin "$BRANCH"
    echo "$NAME pushed."
else
    echo "No $NAME changes to push."
fi

echo ""
echo "All done."
