# claude-code-vertex.sh — route Claude Code dev sessions through Vertex AI so
# development spend draws down the GCP credit pool instead of an Anthropic key.
#
# OPT-IN by SOURCING it, never exec:
#     source scripts/gcp/claude-code-vertex.sh
#
# It only exports env vars into your current shell. Do NOT add these to the
# devcontainer or a global profile — a session must be free to choose its
# billing lane (Anthropic API vs. Vertex credits). Open a fresh shell to opt out.
#
# ── One-time auth (Application Default Credentials) ──────────────────────────
# Claude Code's Vertex path authenticates via ADC, not a service-account key.
# Run this ONCE per machine (interactive; opens a browser / device flow):
#
#     gcloud auth application-default login
#
# That writes ~/.config/gcloud/application_default_credentials.json, which the
# Anthropic Vertex SDK inside Claude Code picks up automatically. If your org
# enforces a reauth interval you will re-run it when the session expires.
#
# Verify ADC is live before starting a session:
#     gcloud auth application-default print-access-token >/dev/null && echo "ADC ok"
#
# ── Usage ────────────────────────────────────────────────────────────────────
#     source scripts/gcp/claude-code-vertex.sh      # this shell now uses Vertex
#     claude                                          # dev spend → GCP credits
#
# Override the project or region inline before sourcing if needed:
#     ANTHROPIC_VERTEX_PROJECT_ID=other-proj source scripts/gcp/claude-code-vertex.sh

# Project: prefer an already-exported value, else the repo default, else the
# active gcloud project. Edit CLAUDE_CODE_VERTEX_PROJECT_DEFAULT if the project changes.
CLAUDE_CODE_VERTEX_PROJECT_DEFAULT="aerial-vehicle-466722-p5"

_ccv_project="${ANTHROPIC_VERTEX_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-}}"
if [ -z "$_ccv_project" ]; then
  _ccv_project="$(gcloud config get-value project 2>/dev/null)"
fi
if [ -z "$_ccv_project" ] || [ "$_ccv_project" = "(unset)" ]; then
  _ccv_project="$CLAUDE_CODE_VERTEX_PROJECT_DEFAULT"
fi

export CLAUDE_CODE_USE_VERTEX=1
export ANTHROPIC_VERTEX_PROJECT_ID="$_ccv_project"
# Claude on Vertex is served from the `global` endpoint for current-gen models.
export CLOUD_ML_REGION="${CLOUD_ML_REGION:-global}"

# Some models (e.g. Haiku snapshots) may only be provisioned in a specific
# region in a given project. If you get a 404 for a model on `global`, point its
# region override at us-central1 — Claude Code reads these per-model vars.
export VERTEX_REGION_CLAUDE_HAIKU_4_5="${VERTEX_REGION_CLAUDE_HAIKU_4_5:-global}"

unset _ccv_project

echo "[claude-code-vertex] CLAUDE_CODE_USE_VERTEX=1"
echo "[claude-code-vertex] ANTHROPIC_VERTEX_PROJECT_ID=$ANTHROPIC_VERTEX_PROJECT_ID"
echo "[claude-code-vertex] CLOUD_ML_REGION=$CLOUD_ML_REGION"
if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  echo "[claude-code-vertex] WARNING: no valid ADC. Run: gcloud auth application-default login" >&2
else
  echo "[claude-code-vertex] ADC ok — 'claude' in this shell now bills to GCP credits."
fi
