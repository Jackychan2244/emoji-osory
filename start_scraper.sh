#!/usr/bin/env bash
set -euo pipefail

# Convenience wrapper for scrape-new-emojis.js with sane defaults.
# Override via env vars or pass additional CLI args to override.
#
# Examples:
#   ./start_scraper.sh
#   CONCURRENCY=2 HEADLESS=true ./start_scraper.sh --vendor apple_ios --only iOS_16.4

CONCURRENCY="${CONCURRENCY:-1}"
MAX_RETRIES="${MAX_RETRIES:-5}"
TIMEOUT="${TIMEOUT:-60000}"
HEADLESS="${HEADLESS:-false}"
SLOWMO="${SLOWMO:-0}"
RESUME="${RESUME:-true}"

args=(
  --concurrency "$CONCURRENCY"
  --max-retries "$MAX_RETRIES"
  --timeout "$TIMEOUT"
  --headless="$HEADLESS"
  --slowmo "$SLOWMO"
)

if [[ "$RESUME" == "true" ]]; then
  args+=(--resume)
else
  args+=(--no-resume)
fi

node scripts/scrape-new-emojis.js "${args[@]}" "$@"
