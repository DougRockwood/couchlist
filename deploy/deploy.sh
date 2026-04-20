#!/usr/bin/env bash
# deploy.sh — pull the latest code from GitHub and restart the server.
#
# This is the one-command deploy loop. RockwoodBot runs it when Doug
# sends a deploy message from Telegram:
#   bash /root/projects/couchlist/deploy/deploy.sh
#
# The script is idempotent and safe to run repeatedly:
#  - If there are no new commits, it exits cleanly without a restart.
#  - If package.json didn't change, it skips `npm install` (slow + can
#    OOM on small droplets).
#  - If anything fails, set -e stops the script before we restart with
#    broken code on disk.

set -euo pipefail                                    # stop on any error, unset var, or pipe failure

cd /root/projects/couchlist                          # everything below happens inside the repo

echo "=== Fetching latest from origin/main ==="
git fetch origin main                                # pulls refs into the repo without changing files

LOCAL=$(git rev-parse HEAD)                          # commit we're currently on
REMOTE=$(git rev-parse origin/main)                  # commit GitHub has for main

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "Already at $LOCAL — nothing to deploy."
    exit 0                                           # nothing new → bail before we restart
fi

echo "=== Pulling changes ($LOCAL → $REMOTE) ==="
git pull --ff-only origin main                       # fast-forward only: refuse if history diverged

# Only reinstall dependencies if the package files actually changed.
# Compares filenames that changed between the old and new commits.
if git diff --name-only "$LOCAL" HEAD | grep -qE '^(package\.json|package-lock\.json)$'; then
    echo "=== package.json changed — running npm install ==="
    npm install --omit=dev                           # --omit=dev skips devDependencies in prod
fi

echo "=== Restarting couchlist.service ==="
systemctl restart couchlist                          # systemd handles stop + start + Restart=always

# Brief status check so Telegram can see whether the restart succeeded.
# --no-pager keeps output flowing to stdout instead of launching `less`.
echo "=== Status after restart ==="
systemctl status couchlist --no-pager --lines=5 || true
