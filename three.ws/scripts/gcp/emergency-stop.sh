#!/usr/bin/env bash
# scripts/gcp/emergency-stop.sh — burn kill-switch for the GCP credit program.
#
# When a lane runs away (a stuck min-instances GPU service, a runaway batch, or
# Vertex Claude flipped to primary during an incident), this stops the bleed:
#
#   1. Drops EVERY Cloud Run service + job to --min-instances=0 so nothing keeps
#      a GPU warm while idle (the expensive failure: min-instances>0 on an L4
#      burns hundreds/day doing nothing).
#   2. Prints the env flags to unset — the true no-deploy kill switches. Flipping
#      these in Vercel reverts each lane to its free/fallback provider instantly,
#      no redeploy required.
#   3. Prints the documented spot/batch stop commands.
#
# This does NOT delete anything — services stay deployed and scale back up on the
# next request. It only removes the always-warm floor and points you at the flags.
#
# Usage:
#   scripts/gcp/emergency-stop.sh            # DRY RUN — shows what it would do
#   scripts/gcp/emergency-stop.sh --apply    # actually drop min-instances to 0
#
# Env:
#   GOOGLE_CLOUD_PROJECT   project id (falls back to gcloud config)

set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

PROJECT="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT" ]]; then
	echo "ERROR: no project. Set GOOGLE_CLOUD_PROJECT or run 'gcloud config set project <id>'." >&2
	exit 1
fi

echo "🛑 GCP CREDIT PROGRAM — EMERGENCY STOP"
echo "   project: $PROJECT   mode: $([[ $APPLY -eq 1 ]] && echo APPLY || echo 'DRY RUN')"
echo

run() {
	if [[ $APPLY -eq 1 ]]; then
		echo "   \$ $*"
		"$@"
	else
		echo "   would run: $*"
	fi
}

# ── 1. Drop all Cloud Run min-instances to 0 ────────────────────────────────
echo "1) Cloud Run services → --min-instances=0"
SERVICES_TSV="$(gcloud run services list --project="$PROJECT" --format='value(metadata.name,region)' 2>/dev/null || true)"
if [[ -z "$SERVICES_TSV" ]]; then
	echo "   (no services found — check gcloud auth / project)"
else
	while IFS=$'\t' read -r name region; do
		[[ -z "$name" ]] && continue
		echo "   • $name ($region)"
		run gcloud run services update "$name" \
			--project="$PROJECT" --region="$region" --min-instances=0 --quiet
	done <<< "$SERVICES_TSV"
fi
echo

echo "   Cloud Run jobs → cancel running executions"
JOBS_TSV="$(gcloud run jobs list --project="$PROJECT" --format='value(metadata.name,region)' 2>/dev/null || true)"
if [[ -z "$JOBS_TSV" ]]; then
	echo "   (no jobs)"
else
	while IFS=$'\t' read -r name region; do
		[[ -z "$name" ]] && continue
		# Cancel any in-flight executions for this job.
		execs="$(gcloud run jobs executions list --job="$name" --project="$PROJECT" --region="$region" \
			--filter='status.completionTime:*' --format='value(metadata.name)' 2>/dev/null | head -n 20 || true)"
		if [[ -n "$execs" ]]; then
			while read -r ex; do
				[[ -z "$ex" ]] && continue
				echo "   • cancel execution $ex ($name)"
				run gcloud run jobs executions cancel "$ex" --project="$PROJECT" --region="$region" --quiet
			done <<< "$execs"
		fi
	done <<< "$JOBS_TSV"
fi
echo

# ── 2. The real no-deploy kill switches (env flags) ─────────────────────────
cat <<'FLAGS'
2) FLIP THESE ENV FLAGS in Vercel to revert each paid lane to its free fallback
   (no redeploy needed — the provider chains read them per-request):

   Vertex Claude   →  vercel env rm VERTEX_CLAUDE_PRIMARY production
                      (unset ⇒ chat falls back to the free/BYOK lanes instantly)

   Forge GPU fleet →  vercel env rm FORGE_SELFHOST_PRIMARY production
                      (unset ⇒ forge routing stops preferring self-host GPU workers)

   Imagen          →  vercel env add VERTEX_IMAGEN_ENABLED production   (value: 0)
                      (0/false/off ⇒ text→image falls back to the free NIM FLUX lane)

   After changing a flag, redeploy is NOT required for it to take effect on new
   serverless invocations, but run `vercel deploy --prod` if you want the change
   reflected immediately in already-warm lambdas.

   For the FULL end-of-program teardown (revert every GCP lane by removing its
   gate env var, credits expiring), use scripts/gcp/revert-to-free.sh instead —
   this script is the fast "stop the bleed now" runaway switch.
FLAGS
echo

# ── 3. Spot / batch stop ────────────────────────────────────────────────────
cat <<FLAGS
3) SPOT / BATCH compute (seeding runs, vanity grinder on GCE) — stop instances:

   gcloud compute instances list --project=$PROJECT
   gcloud compute instances stop <INSTANCE> --zone=<ZONE> --project=$PROJECT
   # or delete a managed instance group's targets:
   gcloud compute instance-groups managed resize <MIG> --size=0 --zone=<ZONE> --project=$PROJECT
FLAGS
echo

echo "── Done. Verify the bleed stopped:  node scripts/gcp/burn-report.mjs"
[[ $APPLY -eq 0 ]] && echo "── This was a DRY RUN. Re-run with --apply to actually drop min-instances."
