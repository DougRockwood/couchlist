#!/bin/bash
# push.sh — run at the end of a session to push this project + claude config

set -e

# --- Claude config (memories, settings, skills) ---
echo "=== Pushing claude-config ==="
cd /root/.claude
if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "sync claude config $(date +%Y-%m-%d)"
    git push origin main
    echo "Claude config pushed."
else
    echo "No claude-config changes to push."
fi

# --- This project ---
echo ""
echo "=== Pushing WhatToWatch ==="
cd /opt/WhatToWatch
if [ -n "$(git status --porcelain)" ]; then
    git add -A
    read -p "Commit message (Enter for datestamp): " msg
    msg="${msg:-sync $(date +%Y-%m-%d)}"
    git commit -m "$msg"
    git push origin main
    echo "WhatToWatch pushed."
else
    echo "No WhatToWatch changes to push."
fi

echo ""
echo "All done."
