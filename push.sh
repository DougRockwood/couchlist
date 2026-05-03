#!/bin/bash
# push.sh — for the couchlist-myshelf clone (test.couchlist.org deploy)
# usage: ./push.sh ["optional commit message"]
# this clone is locked to the myshelf branch — pushes that, plus claude-config (on main)
# DO NOT use this script for the main clone — see /root/projects/couchlist/push.sh for that

set -e

# helper: true when HEAD is ahead of origin/<branch>
# pass "main" for claude-config, "myshelf" for this couchlist clone
ahead_of_origin() {
    local b="${1:-main}"
    git fetch origin "$b" --quiet 2>/dev/null || true
    [ "$(git rev-list --count origin/$b..HEAD 2>/dev/null || echo 0)" -gt 0 ]
}

# --- Claude config (always on main) ---
echo "=== Pushing claude-config ==="
cd /root/.claude
# explicit paths only — skips session churn (history.jsonl, sessions/*.json, projects/*/*.jsonl)
git add -- settings.json agents skills ':(glob)projects/*/memory/**' 2>/dev/null || true
if [ -n "$(git diff --cached --name-only)" ]; then
    git commit -m "sync claude config $(date +%Y-%m-%d)"
fi
if ahead_of_origin; then                                 # default branch = main
    git push origin main
    echo "Claude config pushed."
else
    echo "No claude-config changes to push."
fi

# --- This project — myshelf branch (this clone is locked to myshelf) ---
echo ""
echo "=== Pushing couchlist-myshelf ==="
cd /root/projects/couchlist-myshelf
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
if ahead_of_origin myshelf; then                         # check against origin/myshelf
    git push origin myshelf
    echo "couchlist-myshelf pushed."
else
    echo "No couchlist-myshelf changes to push."
fi

echo ""
echo "All done."
