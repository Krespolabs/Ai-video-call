#!/usr/bin/env bash
#
# publish-extracted.sh — owner-run companion to extract-package.sh.
#
# Creates the standalone GitHub repo, pushes the extracted history, and (for npm
# packages) tags the version so the repo's publish.yml workflow ships it to npm.
#
# Run this with the OWNER's credentials:
#   - `gh auth login` as the account that owns the target namespace (nirholas),
#     OR set the target to your own namespace.
#   - The new repo needs an NPM_TOKEN secret (npm packages) or VSCE_PAT/OVSX_PAT
#     (VS Code extension) for the publish workflow to authenticate.
#
# Usage:
#   scripts/publish-extracted.sh <repo-name> [owner] [--private]
#
# Example:
#   scripts/extract-package.sh packages/x402-fetch x402-fetch nirholas   # build it
#   scripts/publish-extracted.sh x402-fetch nirholas                     # ship it

set -euo pipefail

REPO_NAME="${1:?usage: publish-extracted.sh <repo-name> [owner] [--private]}"
OWNER="${2:-nirholas}"
VIS="--public"; [ "${3:-}" = "--private" ] && VIS="--private"

OUT_DIR="${OUT_DIR:-/tmp/claude-1000/-workspaces-three-ws/d57d4fdd-6fc6-4b30-9b8f-074137e13d3e/scratchpad/extracted}"
DEST="$OUT_DIR/$REPO_NAME"

[ -d "$DEST/.git" ] || { echo "ERROR: $DEST not found — run extract-package.sh first." >&2; exit 1; }
cd "$DEST"

DESC="$(node -p 'require("./package.json").description || ""')"
VERSION="$(node -p 'require("./package.json").version')"

echo "==> creating github.com/$OWNER/$REPO_NAME ($VIS) and pushing history"
gh repo create "$OWNER/$REPO_NAME" $VIS --source "$DEST" --remote origin --push --description "$DESC"

echo "==> tagging v$VERSION (triggers the publish workflow once the token secret is set)"
git tag -f "v$VERSION"
git push -f origin "v$VERSION"

echo ""
echo "DONE: github.com/$OWNER/$REPO_NAME pushed, tagged v$VERSION."
echo "Set the publish secret so the workflow can authenticate:"
echo "  npm packages:  gh secret set NPM_TOKEN  --repo $OWNER/$REPO_NAME"
echo "  vscode ext:    gh secret set VSCE_PAT   --repo $OWNER/$REPO_NAME"
echo "                 gh secret set OVSX_PAT   --repo $OWNER/$REPO_NAME   # optional, Open VSX"
