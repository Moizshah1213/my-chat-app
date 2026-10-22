#!/usr/bin/env bash
# Place at the repo root on the SERVER (~/app/backup.sh), then: chmod +x backup.sh
# Makes a compressed Postgres dump in ./backups and keeps the last 7 days.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups

set -a
source .env
set +a

STAMP="$(date +%F_%H%M)"
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "backups/db_${STAMP}.dump"

# delete dumps older than 7 days
find backups -name 'db_*.dump' -mtime +7 -delete

echo "Backup done: backups/db_${STAMP}.dump"
