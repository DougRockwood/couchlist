#!/bin/bash
# pull.sh — sync this clone (any branch) and claude-config from origin.
# Generic: works from any couchlist clone, pulls whatever branch is checked
# out. Picks up the clone's own directory via $BASH_SOURCE.

set -e

if [ -d /root/.claude ]; then
    echo "=== Pulling claude-config ==="
    cd /root/.claude
    git pull origin main
    echo ""
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
BRANCH="$(git branch --show-current)"
NAME="$(basename "$SCRIPT_DIR")"

echo "=== Pulling $NAME (branch: $BRANCH) ==="
git pull origin "$BRANCH"

echo ""
echo "All synced."
