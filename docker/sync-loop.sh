#!/bin/sh
# Lance la synchronisation immédiatement, puis toutes les SYNC_INTERVAL_SECONDS
# (par défaut 24h). tcgcsv.com republie ses prix une fois par jour.
set -e
INTERVAL="${SYNC_INTERVAL_SECONDS:-86400}"
while true; do
  node scripts/sync.js || echo "Synchronisation échouée, nouvelle tentative dans ${INTERVAL}s"
  sleep "$INTERVAL"
done
