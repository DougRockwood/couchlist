#!/bin/bash
# pull.sh — run at the start of a session to sync this project + claude config
# pulls both main and myshelf so neither falls behind

set -e

# helper: fast-forward local <branch> to origin/<branch>
# uses git pull if you're currently on that branch (HEAD has to move),
# otherwise uses the fetch refspec syntax to update the ref without checkout
pull_branch() {
    local b="$1"
    if [ "$(git branch --show-current)" = "$b" ]; then
        git pull --ff-only origin "$b"
    else
        # "origin foo:foo" = fetch origin's foo into local foo — only works ff-only,
        # which is exactly what we want (won't clobber a branch you've diverged on)
        git fetch origin "$b:$b" || echo "  ($b can't fast-forward — diverged from origin?)"
    fi
}

echo "=== Pulling claude-config ==="
cd /root/.claude
git pull origin main

echo ""
echo "=== Pulling couchlist ==="
cd /root/projects/couchlist
pull_branch main
pull_branch myshelf

echo ""
echo "All synced."
