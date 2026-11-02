#!/usr/bin/env bash
# One-time pm2-logrotate setup (run as the PM2 user on the pilot server). Idempotent.
set -euo pipefail
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:workerInterval 60
pm2 conf pm2-logrotate | head -n 30
