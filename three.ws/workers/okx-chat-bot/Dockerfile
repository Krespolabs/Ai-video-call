# okx-chat-bot: always-on host for the OKX.AI marketplace chat bot (agent #2632).
#
# Build from the REPO ROOT (it imports api/_lib/* for the catalog briefing, the
# GCS token minter, the alert sink and the DB client):
#
#   docker build -f workers/okx-chat-bot/Dockerfile -t okx-chat-bot .
#   docker run --env-file .env -e PORT=8080 -p 8080:8080 okx-chat-bot
#
# Three external pieces are baked in, and each one is here because installing it
# at runtime is exactly how the codespace version kept breaking:
#
#   okx-a2a    the XMTP daemon. Node >= 22.14 or it refuses to start.
#   onchainos  the OKX wallet CLI. The release binary itself, verified against
#              the release's checksums.txt, installed straight into /usr/local/bin:
#              at runtime HOME is the restored state tree, so a binary living in
#              $HOME/.local/bin would vanish the moment a snapshot was unpacked
#              over it.
#   an AI CLI  the adapter spawns it to author replies and drive the task
#              lifecycle. Both supported agentic CLIs ship so the provider can be
#              switched by env alone (see workers/okx-chat-bot/config.js).

FROM node:24-slim

# tar/gzip drive the state snapshots; ca-certificates and curl serve the
# checksum-verified onchainos install below.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl tar gzip git \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The two CLIs the adapter drives, plus the agentic AI CLIs it can spawn.
RUN npm install -g \
	@okxweb3/a2a-node@latest \
	@anthropic-ai/claude-code@latest \
	@openai/codex@latest

# onchainos: the release binary for this platform, verified against the
# release's own checksums.txt before it is made executable. Releases from v4.6.0
# on ship no install.sh and no installer-checksums.txt (both 404 on v4.6.3), so
# the installer route the first build used now fails the image outright. The
# binary route is the same artifact the installer downloaded, minus the script.
RUN set -eux; \
	TAG="$(curl -fsSL https://api.github.com/repos/okx/onchainos-skills/releases/latest | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).tag_name))')"; \
	case "$(uname -m)" in \
		x86_64) TARGET=x86_64-unknown-linux-gnu ;; \
		aarch64) TARGET=aarch64-unknown-linux-gnu ;; \
		*) echo "no onchainos build for $(uname -m)"; exit 1 ;; \
	esac; \
	cd /tmp; \
	curl -fsSL "https://github.com/okx/onchainos-skills/releases/download/${TAG}/onchainos-${TARGET}" -o "onchainos-${TARGET}"; \
	curl -fsSL "https://github.com/okx/onchainos-skills/releases/download/${TAG}/checksums.txt" -o onchainos-checksums.txt; \
	grep " onchainos-${TARGET}\$" onchainos-checksums.txt | sha256sum -c -; \
	install -m 0755 "onchainos-${TARGET}" /usr/local/bin/onchainos; \
	rm -f "onchainos-${TARGET}" onchainos-checksums.txt; \
	onchainos --version

# Repo deps first for layer caching. .npmrc carries legacy-peer-deps; --ignore-scripts
# skips the postinstall git-hook wiring, which has no meaning in an image.
COPY .npmrc package.json package-lock.json* ./
RUN npm ci --ignore-scripts --omit=dev || npm install --ignore-scripts --omit=dev

# Only what the worker actually imports or stages: the api/_lib modules it uses,
# the worker itself, and the skills it copies into the AI workspace.
COPY api ./api
COPY workers/okx-chat-bot ./workers/okx-chat-bot
COPY .agents/skills ./.agents/skills

ENV NODE_ENV=production \
	OKX_BOT_HOME=/state \
	OKX_BOT_REPO_ROOT=/app

# The state tree is created here rather than by the entrypoint so a read-only
# rootfs or a stricter runtime user surfaces at build time, not at 3am.
RUN mkdir -p /state

CMD ["node", "workers/okx-chat-bot/index.js"]
