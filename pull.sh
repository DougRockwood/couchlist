#!/bin/bash
# pull.sh — run at the start of a session to sync this project + claude config

set -e

echo "=== Pulling claude-config ==="
cd /root/.claude
git pull origin main

echo ""
echo "=== Pulling WhatToWatch ==="
cd /opt/WhatToWatch
git pull origin hail-mary

echo ""
echo "All synced."
