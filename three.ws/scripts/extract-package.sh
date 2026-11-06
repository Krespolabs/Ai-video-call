#!/usr/bin/env bash
#
# extract-package.sh — split a package out of the three.ws monorepo into a
# standalone git repository (history preserved) that is ready to push to GitHub
# and publish to npm.
#
# Usage:
#   scripts/extract-package.sh <prefix> <repo-name> [github-owner]
#
# Example:
#   scripts/extract-package.sh packages/x402-fetch x402-fetch nirholas
#
# What it does:
#   1. `git subtree split` the <prefix> into a branch whose root IS the package.
#   2. Materialise a fresh standalone repo under $OUT_DIR/<repo-name> with the
#      full commit history for that path (no monorepo noise).
#   3. Rewrite package.json `repository`/`bugs` to point at the new repo.
#   4. Drop in a CI workflow that publishes to npm with provenance on tag push.
#   5. Verify it is publishable: install, build, test, `npm publish --dry-run`.
#
# It does NOT create the GitHub repo or publish — those need the owner's
# credentials. It prints the exact handoff commands at the end.

set -euo pipefail

PREFIX="${1:?usage: extract-package.sh <prefix> <repo-name> [owner]}"
REPO_NAME="${2:?usage: extract-package.sh <prefix> <repo-name> [owner]}"
OWNER="${3:-nirholas}"

MONOREPO="$(git rev-parse --show-toplevel)"
OUT_DIR="${OUT_DIR:-/tmp/claude-1000/-workspaces-three-ws/d57d4fdd-6fc6-4b30-9b8f-074137e13d3e/scratchpad/extracted}"
DEST="$OUT_DIR/$REPO_NAME"
SPLIT_BRANCH="split/$REPO_NAME"

if [ ! -f "$MONOREPO/$PREFIX/package.json" ]; then
  echo "ERROR: $PREFIX/package.json not found" >&2
  exit 1
fi

echo "==> [1/5] clone monorepo + filter history to $PREFIX"
rm -rf "$DEST"
mkdir -p "$OUT_DIR"
# Fresh mirror-ish clone so filter-repo can rewrite without touching the working repo.
git clone -q --no-local "$MONOREPO" "$DEST"
cd "$DEST"
git remote remove origin 2>/dev/null || true

echo "==> [2/5] rewrite '$PREFIX/' to repo root (history preserved for that path)"
git filter-repo --force --subdirectory-filter "$PREFIX"
# Land on a clean `main` branch.
git branch -m main 2>/dev/null || git checkout -q -b main

echo "==> [3/5] rewrite package.json repository/bugs -> $OWNER/$REPO_NAME"
OWNER="$OWNER" REPO_NAME="$REPO_NAME" node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const owner = process.env.OWNER, repo = process.env.REPO_NAME;
  p.repository = { type: "git", url: `git+https://github.com/${owner}/${repo}.git` };
  p.bugs = { url: `https://github.com/${owner}/${repo}/issues` };
  if (!p.homepage) p.homepage = `https://github.com/${owner}/${repo}#readme`;
  fs.writeFileSync("package.json", JSON.stringify(p, null, "\t") + "\n");
'

echo "==> [4/5] add npm publish CI workflow"
mkdir -p .github/workflows
# A VS Code extension publishes to the Marketplace (vsce) + Open VSX, not npm.
IS_VSCODE="$(node -p 'require("./package.json").engines?.vscode ? "1" : ""' 2>/dev/null)"
if [ -n "$IS_VSCODE" ]; then
cat > .github/workflows/publish.yml <<'YML'
name: publish
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci || npm install
      - run: npm run build --if-present
      - run: npx --yes @vscode/vsce publish -p "$VSCE_PAT"
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
      - run: npx --yes ovsx publish -p "$OVSX_PAT"
        env:
          OVSX_PAT: ${{ secrets.OVSX_PAT }}
        continue-on-error: true
YML
else
cat > .github/workflows/publish.yml <<'YML'
name: publish
on:
  push:
    tags: ['v*']
permissions:
  contents: read
  id-token: write   # npm provenance
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org
      - run: npm ci || npm install
      - run: npm test --if-present
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
YML
fi
[ -f .gitignore ] || printf 'node_modules\ndist\n*.log\n.DS_Store\n' > .gitignore
git add -A

echo "==> [5/5] verify publishable (install, build, test, dry-run pack)"
npm install --no-audit --no-fund >/dev/null 2>&1 || { echo "npm install failed"; exit 1; }
npm run build --if-present
npm test --if-present || { echo "tests failed"; exit 1; }
if [ -n "$IS_VSCODE" ]; then
  echo "--- vsce package (VS Code extension — Marketplace target, not npm) ---"
  npx --yes @vscode/vsce package --no-dependencies -o "/tmp/$REPO_NAME.vsix" 2>&1 | tail -8 \
    && echo "VSIX OK: publish with 'vsce publish' (Marketplace) + 'ovsx publish' (Open VSX), not npm." \
    || echo "NOTE: vsce package needs review (Marketplace target)."
else
  echo "--- npm publish --dry-run ---"
  DRY="$(npm publish --dry-run --access public 2>&1 || true)"
  echo "$DRY" | tail -20
  if echo "$DRY" | grep -q "cannot publish over"; then
    echo "NOTE: version already on npm — bump 'version' before the real publish (expected for a migration of an already-published package)."
  elif echo "$DRY" | grep -qiE "npm error|ERR!"; then
    echo "ERROR: publish dry-run reported a real problem above." >&2
    exit 1
  fi
fi

git -c user.email="claude@three.ws" -c user.name="three.ws" commit -q -m "chore: standalone repo scaffolding (CI, repository metadata)" || true

echo ""
echo "================================================================"
echo "READY: $DEST"
echo "Commits: $(git rev-list --count HEAD)  |  package: $(node -p 'require("./package.json").name')@$(node -p 'require("./package.json").version')"
echo ""
echo "Owner handoff (run with nirholas GitHub + npm creds):"
echo "  gh repo create $OWNER/$REPO_NAME --public --source $DEST --remote origin --push \\"
echo "    --description \"$(node -p 'require("./package.json").description||""')\""
echo "  # add NPM_TOKEN secret, then:"
echo "  cd $DEST && git tag v$(node -p 'require("./package.json").version') && git push origin v$(node -p 'require("./package.json").version')"
echo "================================================================"
