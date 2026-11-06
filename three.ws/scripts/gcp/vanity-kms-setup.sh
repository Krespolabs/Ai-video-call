#!/usr/bin/env bash
#
# vanity-kms-setup.sh — provision GCP KMS envelope encryption for the premium
# vanity inventory, and grant decrypt to ONLY the delivery service identity.
#
# This is the "insider access" mitigation for stored private keys (see the threat
# model in docs/gcp-credits.md). secret-box (WALLET_ENCRYPTION_KEY) already
# protects against a DB dump; KMS adds IAM-gated, audit-logged decrypt so no
# single env-var leak can silently decrypt the whole inventory offline.
#
# Idempotent: safe to re-run. Prints the VANITY_KMS_KEY value to set in Vercel
# (delivery side) and for the grinder job (encrypt side).
#
# Prereqs: gcloud authed to the project (prompt 01). Enables cloudkms.googleapis.com.
#
# Usage:
#   PROJECT_ID=my-proj ./scripts/gcp/vanity-kms-setup.sh
#
# Env:
#   PROJECT_ID           required
#   LOCATION             default us-central1  (KMS location for the keyring)
#   KEYRING              default three-vanity
#   KEY                  default inventory-secrets
#   DELIVERY_SA          the SA the Vercel delivery function runs as
#                        (default vercel-inference@$PROJECT_ID.iam.gserviceaccount.com)
#   GRINDER_SA           the SA the batch grinder runs as (needs encrypt only)
#                        (default vanity-grinder@$PROJECT_ID.iam.gserviceaccount.com)

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to your GCP project}"
LOCATION="${LOCATION:-us-central1}"
KEYRING="${KEYRING:-three-vanity}"
KEY="${KEY:-inventory-secrets}"
DELIVERY_SA="${DELIVERY_SA:-vercel-inference@${PROJECT_ID}.iam.gserviceaccount.com}"
GRINDER_SA="${GRINDER_SA:-vanity-grinder@${PROJECT_ID}.iam.gserviceaccount.com}"

echo "▸ Enabling Cloud KMS API…"
gcloud services enable cloudkms.googleapis.com --project "$PROJECT_ID"

echo "▸ Keyring $KEYRING ($LOCATION)…"
gcloud kms keyrings create "$KEYRING" --location "$LOCATION" --project "$PROJECT_ID" 2>/dev/null \
	|| echo "  (keyring already exists)"

echo "▸ Crypto key $KEY (rotation 90d)…"
gcloud kms keys create "$KEY" \
	--location "$LOCATION" --keyring "$KEYRING" \
	--purpose encryption --rotation-period 90d --next-rotation-time "$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+90d +%Y-%m-%dT%H:%M:%SZ)" \
	--project "$PROJECT_ID" 2>/dev/null \
	|| echo "  (key already exists)"

KEY_RESOURCE="projects/${PROJECT_ID}/locations/${LOCATION}/keyRings/${KEYRING}/cryptoKeys/${KEY}"

echo "▸ Granting DECRYPT to the delivery identity ONLY ($DELIVERY_SA)…"
gcloud kms keys add-iam-policy-binding "$KEY" \
	--location "$LOCATION" --keyring "$KEYRING" \
	--member "serviceAccount:${DELIVERY_SA}" \
	--role roles/cloudkms.cryptoKeyDecrypter \
	--project "$PROJECT_ID" >/dev/null

echo "▸ Granting ENCRYPT to the grinder identity ($GRINDER_SA) — encrypt, NOT decrypt…"
gcloud kms keys add-iam-policy-binding "$KEY" \
	--location "$LOCATION" --keyring "$KEYRING" \
	--member "serviceAccount:${GRINDER_SA}" \
	--role roles/cloudkms.cryptoKeyEncrypter \
	--project "$PROJECT_ID" >/dev/null

cat <<EOF

✅ KMS ready. Set this on BOTH the grinder job and the Vercel delivery function:

    VANITY_KMS_KEY=${KEY_RESOURCE}

  • Grinder (encrypt) runs as: ${GRINDER_SA}   (cryptoKeyEncrypter)
  • Delivery (decrypt) runs as: ${DELIVERY_SA}  (cryptoKeyDecrypter)

  Set in Vercel:  vercel env add VANITY_KMS_KEY production   # paste the value above
  Least privilege: the grinder can seal keys but can NEVER read them back; only
  the delivery function can decrypt, and every decrypt is Cloud-Audit-Logged.
EOF
