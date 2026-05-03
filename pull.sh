#!/bin/bash
# pull.sh — for the couchlist-myshelf clone (test.couchlist.org deploy)
# this clone is locked to the myshelf branch — pulls that, plus claude-config (on main)
# DO NOT use this script for the main clone — see /root/projects/couchlist/pull.sh for that

set -e

echo "=== Pulling claude-config ==="
cd /root/.claude
git pull origin main

echo ""
echo "=== Pulling couchlist-myshelf ==="
cd /root/projects/couchlist-myshelf
git pull origin myshelf

echo ""
echo "All synced."
