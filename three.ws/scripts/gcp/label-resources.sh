#!/usr/bin/env bash
# scripts/gcp/label-resources.sh — attribution labels for the $100k credit program.
#
# Every credit-consuming resource created in prompts 02–06 must carry a
# consistent label so the burn report (scripts/gcp/burn-report.mjs) can split
# spend by lane. This script discovers the fleet and (retro-)labels it:
#
#   program=gcp-credits      on every program resource
#   lane=forge-gpu           on the Cloud Run GPU model workers
#   lane=<forge-gpu|...>      overridable per service (see LANE_OVERRIDES below)
#
# Vertex Claude + Imagen spend is API-billed (no Cloud Run service to label) and
# is attributed by service.description in the burn report instead; the vanity
# lane, when it runs as a Cloud Run job / GCE VM, is labeled here too.
#
# Labels are additive (--update-labels), so this is safe to re-run and safe to
# run against a partially-labeled fleet.
#
# Usage:
#   scripts/gcp/label-resources.sh            # DRY RUN — prints what it would do
#   scripts/gcp/label-resources.sh --apply    # actually apply the labels
#
# Env:
#   GOOGLE_CLOUD_PROJECT   project id (falls back to `gcloud config get-value project`)
#   GCP_CREDIT_PROGRAM     program label value (default: gcp-credits)

set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

PROJECT="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
PROGRAM="${GCP_CREDIT_PROGRAM:-gcp-credits}"

if [[ -z "$PROJECT" ]]; then
	echo "ERROR: no project. Set GOOGLE_CLOUD_PROJECT or run 'gcloud config set project <id>'." >&2
	exit 1
fi

# Per-service lane overrides. Anything not listed defaults to forge-gpu (the
# whole Cloud Run fleet in this project is the GPU model lane; the API runs on
# Vercel, not Cloud Run). Format: "service-name=lane".
declare -A LANE_OVERRIDES=(
	# ["vanity-grinder"]="vanity"
	# Platform services that predate the credit program — they draw the same
	# credit pool but are not a forge-gpu lane; attribute them separately.
	["agent-sniper"]="platform"
	["hyperfy-world"]="platform"
	["three-ws-multiplayer"]="platform"
)

# GCS buckets that back the credit program (model weights, reconstruction output).
BUCKETS=(
	"three-ws-model-weights"
	"three-ws-avatar-reconstructions"
	"three-ws-longcat-weights"
	"three-ws-avatar-videos"
)

echo "── GCP credit-program labeler ──────────────────────────────────────"
echo "   project: $PROJECT   program=$PROGRAM   mode: $([[ $APPLY -eq 1 ]] && echo APPLY || echo 'DRY RUN')"
echo

FAILURES=0

run() {
	if [[ $APPLY -eq 1 ]]; then
		echo "   \$ $*"
		# One resource failing must not abort the sweep — labels are additive
		# and independent per resource. Count and report at the end.
		"$@" || { echo "   ✗ FAILED (continuing): $*" >&2; FAILURES=$((FAILURES + 1)); }
	else
		echo "   would run: $*"
	fi
}

# ── Cloud Run services ──────────────────────────────────────────────────────
echo "Cloud Run services:"
# Region must come from the location label — the `region` alias collapses in
# value() output and shifts columns when the lane label is absent.
SERVICES_TSV="$(gcloud run services list --project="$PROJECT" --format='value(metadata.name,metadata.labels."cloud.googleapis.com/location",metadata.labels.lane)' 2>/dev/null || true)"
if [[ -z "$SERVICES_TSV" ]]; then
	echo "   (none found — deploy prompt 04's workers first, or check gcloud auth)"
else
	while IFS=$'\t' read -r name region existing_lane; do
		[[ -z "$name" ]] && continue
		if [[ -z "$region" ]]; then
			echo "   • $name — SKIPPED: could not resolve region" >&2
			continue
		fi
		lane="${LANE_OVERRIDES[$name]:-forge-gpu}"
		echo "   • $name (region=$region, current lane=${existing_lane:-none}) → lane=$lane"
		run gcloud run services update "$name" \
			--project="$PROJECT" --region="$region" \
			--update-labels="program=${PROGRAM},lane=${lane}" --quiet
	done <<< "$SERVICES_TSV"
fi
echo

# ── Cloud Run jobs (batch: vanity, seeding) ─────────────────────────────────
echo "Cloud Run jobs:"
JOBS_TSV="$(gcloud run jobs list --project="$PROJECT" --format='value(metadata.name,metadata.labels."cloud.googleapis.com/location")' 2>/dev/null || true)"
if [[ -z "$JOBS_TSV" ]]; then
	echo "   (none)"
else
	while IFS=$'\t' read -r name region; do
		[[ -z "$name" ]] && continue
		lane="${LANE_OVERRIDES[$name]:-forge-gpu}"
		echo "   • $name (job, region=$region) → lane=$lane"
		run gcloud run jobs update "$name" \
			--project="$PROJECT" --region="$region" \
			--update-labels="program=${PROGRAM},lane=${lane}" --quiet
	done <<< "$JOBS_TSV"
fi
echo

# ── GCS buckets ─────────────────────────────────────────────────────────────
echo "GCS buckets:"
for b in "${BUCKETS[@]}"; do
	if gcloud storage buckets describe "gs://$b" --project="$PROJECT" >/dev/null 2>&1; then
		echo "   • gs://$b → lane=forge-gpu"
		run gcloud storage buckets update "gs://$b" \
			--update-labels="program=${PROGRAM},lane=forge-gpu"
	else
		echo "   • gs://$b (absent — skipped)"
	fi
done
echo

echo "── Done. Verify attribution:  node scripts/gcp/burn-report.mjs"
[[ $APPLY -eq 0 ]] && echo "── This was a DRY RUN. Re-run with --apply to write the labels."
