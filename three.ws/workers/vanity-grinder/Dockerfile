# Batch vanity grinder — GCP spot CPU container.
#
# Build from the REPO ROOT so the repo-relative imports (../../src, ../../api)
# resolve inside the image exactly as they do in the working tree:
#   docker build -f workers/vanity-grinder/Dockerfile -t vanity-grinder .
#
# Runs the same WASM ed25519 grind engine as the serverless tier, seals every
# found key in-process (api/_lib/vanity-vault.js), and writes ONLY ciphertext —
# to the DB (WRITE_DB=1) and/or an encrypted JSONL. No plaintext key ever hits
# disk, a log, or the network. See README.md.

FROM node:22-slim AS base
WORKDIR /app

# Install only the batch grinder's runtime deps (bs58 + optional Neon driver).
COPY workers/vanity-grinder/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Copy the source the grinder imports, preserving repo-relative layout so
# ../../src and ../../api resolve. src/solana carries the prebuilt WASM engine,
# whose glue (vanity_grinder.js) imports src/shared/log.js — src/shared MUST be
# copied too or every worker crashes at load with "Cannot find module .../shared/log.js".
COPY src/solana ./src/solana
COPY src/shared ./src/shared
COPY api/_lib ./api/_lib
COPY workers/vanity-grinder ./workers/vanity-grinder

# Non-root: the job never needs privileges.
USER node

# Encrypted output lives under /app/out by default; override OUTPUT_FILE to a
# mounted volume / /tmp, or set WRITE_DB=1 to write straight to vanity_inventory.
ENV OUTPUT_FILE=/tmp/inventory.jsonl \
    CHECKPOINT_FILE=/tmp/checkpoint.json \
    SUMMARY_FILE=/tmp/summary.json \
    RUNNER=cloud-run-job

ENTRYPOINT ["node", "workers/vanity-grinder/grind.mjs"]
