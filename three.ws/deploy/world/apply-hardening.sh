#!/usr/bin/env bash
# One-shot hardening for world.three.ws (Hyperfy on Cloud Run).
#
# Why: without ADMIN_CODE, Hyperfy grants EVERY visitor admin rights — anyone
# can delete the ground, replace the scene, or fill the world with broken GLBs.
# This is what broke the world on 2026-06-12 (scene script asset lost, every
# player fell into the void on join).
#
# Run from the repo root with an account that has Cloud Run, Secret Manager,
# and Cloud Build access on project aerial-vehicle-466722-p5:
#   bash deploy/world/apply-hardening.sh
#
# It prints the generated admin code once. Store it in a password manager —
# in-world, builders claim rights with the chat command: /admin <code>

set -euo pipefail

PROJECT=aerial-vehicle-466722-p5
REGION=us-central1
SERVICE=hyperfy-world
RUNTIME_SA=hyperfy-world-sa@${PROJECT}.iam.gserviceaccount.com
SECRET=hyperfy-admin-code
# Build identity for `gcloud builds submit`. This project has no legacy Cloud
# Build service account (newer GCP projects don't auto-create
# <projectNumber>@cloudbuild.gserviceaccount.com), so an unqualified submit fails
# with "Unknown service account". Build as the dedicated build SA the other
# images use; override with BUILD_SERVICE_ACCOUNT if it's renamed. The
# cloudbuild.yaml sets logging: CLOUD_LOGGING_ONLY, which a user-specified SA needs.
BUILD_SA=${BUILD_SERVICE_ACCOUNT:-three-ws-build@${PROJECT}.iam.gserviceaccount.com}

gcloud config set project "$PROJECT" >/dev/null

if gcloud secrets describe "$SECRET" >/dev/null 2>&1; then
  echo "Secret $SECRET already exists — keeping the existing code."
else
  CODE=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)
  printf '%s' "$CODE" | gcloud secrets create "$SECRET" --data-file=-
  echo "Created secret $SECRET."
  echo "ADMIN CODE (store this now, it is not shown again): $CODE"
fi

gcloud secrets add-iam-policy-binding "$SECRET" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role=roles/secretmanager.secretAccessor >/dev/null
echo "Granted secretAccessor to $RUNTIME_SA."

# Rebuild the image: picks up the pinned upstream ref and the server-side
# upload-size patch in patches/.
gcloud builds submit --config deploy/world/cloudbuild.yaml \
  --service-account="projects/${PROJECT}/serviceAccounts/${BUILD_SA}" \
  deploy/world/

# Apply the service config: ADMIN_CODE + PUBLIC_MAX_UPLOAD_SIZE=16.
gcloud run services replace deploy/world/cloudrun.yaml --region="$REGION"

echo "Waiting for the new revision to serve and report protected:true..."
# A min-instance service swaps traffic to the new revision only after it passes
# its startup probe, so poll rather than guessing with a fixed sleep. The
# fail-closed patch (patches/0003) makes a secret-less revision refuse to boot,
# so if protected never flips, the previous revision is still serving and the
# rollout needs a look — don't exit 0 on a silent failure.
STATUS=""
for attempt in $(seq 1 30); do
  STATUS=$(curl -fsS --max-time 10 https://world.three.ws/status 2>/dev/null || echo '{}')
  case "$STATUS" in
    *'"protected":true'*) break ;;
  esac
  sleep 5
done
echo "live /status: $STATUS"
case "$STATUS" in
  *'"protected":true'*) echo "OK — world is protected. Visitors can no longer build." ;;
  *) echo "WARNING — /status does not report protected:true after ~150s. Check the rollout:"
     echo "  gcloud run revisions list --service=$SERVICE --region=$REGION"
     echo "  gcloud run services logs read $SERVICE --region=$REGION --limit=50"
     exit 1 ;;
esac
