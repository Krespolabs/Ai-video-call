#!/usr/bin/env bash
# scripts/gcp/apply-s3-env.sh — apply the R2/S3 storage credentials to the
# three-ws-api Cloud Run service from a local env file.
#
# Why this exists: the Vercel→Cloud Run migration left the S3_* group unset on
# the service (the 89-var apply was blocked on gcloud reauth). Every endpoint
# that resolves avatar/model asset URLs — /api/avatars/:id, /api/explore,
# /api/marketplace — throws `Missing required env var: S3_*` and returns
# 503 not_configured until these five vars are set.
#
# Usage (needs a human-authed gcloud — run `gcloud auth login` first):
#   scripts/gcp/apply-s3-env.sh [path-to-env-file]   # default: .env.local
#
# Applying env vars rolls a new Cloud Run revision; traffic shifts when it's
# healthy. Verify afterwards:
#   curl -s https://three.ws/api/marketplace | head -c 200
set -euo pipefail

PROJECT=aerial-vehicle-466722-p5
SERVICE=three-ws-api
REGION=us-central1
KEYS=(S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_BUCKET S3_PUBLIC_DOMAIN)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${1:-$REPO_ROOT/.env.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "env file not found: $ENV_FILE" >&2
  exit 1
fi

# Build KEY=value pairs with the ^@^ delimiter so values containing commas
# survive --update-env-vars.
pairs=""
for key in "${KEYS[@]}"; do
  # last occurrence wins; strip optional quotes around the value
  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  if [[ -z "$value" ]]; then
    echo "MISSING in $ENV_FILE: $key" >&2
    exit 1
  fi
  pairs+="${pairs:+@}${key}=${value}"
done

echo "Applying ${#KEYS[@]} vars (${KEYS[*]}) to $SERVICE…"
gcloud run services update "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --update-env-vars "^@^${pairs}"

echo
echo "Verifying the previously-503 endpoints:"
for path in /api/marketplace "/api/explore?source=all&limit=1"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://three.ws${path}")"
  echo "  ${path} → ${code}"
done
