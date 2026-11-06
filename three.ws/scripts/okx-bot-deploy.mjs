#!/usr/bin/env node
// Ship the OKX marketplace chat bot (workers/okx-chat-bot) in one command.
//
//   npm run okx:bot:deploy                 # preflight, provision, build, submit, verify
//   npm run okx:bot:deploy -- --dry-run    # preflight and provisioning plan only: writes nothing, submits nothing
//   npm run okx:bot:deploy -- --allow-dirty  # submit the working tree instead of a clean worktree of HEAD
//
// What "one command" has to cover, in order:
//
//   1. gcloud is authenticated (every later step needs it).
//   2. The worker is built from a CLEAN worktree of HEAD, never from the shared
//      working tree: the image copies all of api/, and other agents' in-flight
//      edits there would otherwise ship inside the bot. A dirty
//      workers/okx-chat-bot/ is refused, because that is uncommitted bot code the
//      clean build would silently leave out.
//   3. The payment-free AI lane exists: scripts/okx-bot-llm-gateway.mjs --apply
//      (idempotent) provisions the metering agent, the service-account key and
//      the Secret Manager secret, then proves the lane with the bot's own probe.
//      Its agent id becomes the build's _GATEWAY_AGENT.
//   4. Whether the live API already serves the agent-scoped SDK path the lane
//      calls. It is not a blocker: the lane is elected on a live probe every 15
//      minutes, so if the API deploy lands second the bot moves onto the lane by
//      itself. It is reported so nobody reads a Vertex-only bot as a failure.
//   5. Submit workers/okx-chat-bot/cloudbuild.yaml.
//   6. Verify on the platform's own health view (no gcloud, no secret): the
//      okx_chat_bot subsystem must report the NEW revision as its host. The new
//      instance first waits for the single-writer lease (workers/okx-chat-bot/
//      lease.js) while the old one drains, so this poll is expected to take a
//      couple of minutes, not seconds.
//
// Owner-gated: this deploys to production. Run it only on the owner's say-so.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ALLOW_DIRTY = args.includes('--allow-dirty');
const PROJECT = 'aerial-vehicle-466722-p5';
const REGION = 'us-central1';
const SERVICE = 'okx-chat-bot';
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const WORKTREE = resolve(ROOT, '..', '.okx-bot-deploy-wt');
const HEALTHZ = 'https://three.ws/api/healthz';
const VERSION = 'https://three.ws/api/version';
// The commit that taught the proxy the SDK path and the Claude Code request
// shape (system turns inside messages). The live API needs it for the lane.
const SDK_PATH_COMMIT = 'd3074c1c8';
const VERIFY_TIMEOUT_MS = 15 * 60_000;

const say = (...m) => console.log(...m);
const step = (n, title) => say(`\n[${n}] ${title}`);
const die = (msg, code = 1) => {
	console.error(`\n  FAILED: ${msg}\n`);
	process.exit(code);
};

const git = (argv, opts = {}) => run('git', argv, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, ...opts });

function stream(cmd, argv, opts = {}) {
	return new Promise((res, rej) => {
		const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'inherit'], ...opts });
		let out = '';
		child.stdout.on('data', (d) => {
			out += d;
			process.stdout.write(d);
		});
		child.on('error', rej);
		child.on('close', (code) => (code === 0 ? res(out) : rej(Object.assign(new Error(`${cmd} exited ${code}`), { code, out }))));
	});
}

async function okxSubsystem() {
	const res = await fetch(HEALTHZ, { signal: AbortSignal.timeout(20_000) });
	const body = await res.json();
	return (body?.subsystems?.subsystems || []).find((s) => s.name === 'okx_chat_bot') || null;
}

async function liveApiHasSdkPath() {
	const v = await fetch(VERSION, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
	const live = v?.commit;
	if (!live) return { ok: false, detail: '/api/version reported no commit' };
	try {
		await git(['merge-base', '--is-ancestor', SDK_PATH_COMMIT, live]);
		return { ok: true, detail: `live API ${v.commitShort} (${v.runtime?.revision}) contains ${SDK_PATH_COMMIT}` };
	} catch {
		return { ok: false, detail: `live API ${v.commitShort} (${v.runtime?.revision}) predates ${SDK_PATH_COMMIT}` };
	}
}

async function main() {
	step(1, 'gcloud authentication');
	try {
		await run('gcloud', ['auth', 'print-access-token'], { timeout: 30_000 });
		say('  ok');
	} catch {
		const msg = 'gcloud is not authenticated here: run `gcloud auth login` (and `gcloud auth application-default login`), then re-run';
		if (!DRY) die(msg);
		say(`  WARNING: ${msg}`);
	}

	step(2, 'build source');
	const { stdout: dirty } = await git(['status', '--porcelain', '--', 'workers/okx-chat-bot', 'scripts/okx-bot-llm-gateway.mjs', 'scripts/okx-bot-deploy.mjs']);
	let context = WORKTREE;
	if (ALLOW_DIRTY) {
		context = ROOT;
		say('  --allow-dirty: submitting the working tree as it is, including any uncommitted edits under api/');
	} else if (dirty.trim() && DRY) {
		say(`  WARNING: uncommitted bot code; a real run refuses until it is committed:\n${dirty}`);
	} else if (dirty.trim()) {
		die(
			`uncommitted bot code would be left out of a clean build:\n${dirty}\n` +
				'  Commit it (the owner approves this content), or pass --allow-dirty to ship the working tree.',
		);
	} else {
		const { stdout: head } = await git(['rev-parse', '--short', 'HEAD']);
		say(`  clean worktree of HEAD ${head.trim()} at ${WORKTREE}`);
	}

	step(3, 'AI gateway lane (metering agent, key, secret, live probe)');
	const gw = await stream(process.execPath, ['scripts/okx-bot-llm-gateway.mjs', DRY ? '--verify' : '--apply'], { cwd: ROOT }).catch((err) => {
		// Exit 2 is "provisioned, but the probe did not pass yet" (the SDK path is
		// not live): the deploy still proceeds, see step 4.
		if (err.code === 2) return err.out;
		if (DRY) return err.out || '';
		die('provisioning the gateway lane failed (output above)');
	});
	const agentMatch = /OKX_BOT_ANTHROPIC_BASE_URL=\S+\/agents\/([0-9a-f-]{36})/.exec(gw || '');
	if (!agentMatch && !DRY) die('the gateway script did not report a metering agent id');
	const agentId = agentMatch?.[1] || '<provisioned by --apply>';

	step(4, 'live API serves the agent-scoped SDK path');
	const api = await liveApiHasSdkPath();
	say(`  ${api.ok ? 'yes' : 'NOT YET'}: ${api.detail}`);
	if (!api.ok) {
		say('  The bot still deploys and keeps serving on its current lane. Deploy the API (`npm run deploy:gcp:full`)');
		say('  and the next 15-minute election moves it onto the gateway lane with no second worker deploy.');
	}

	const substitutions = `SHORT_SHA=manual${Math.floor(Date.now() / 1000)},_GATEWAY_AGENT=${agentId}`;
	const submitArgs = [
		'builds',
		'submit',
		'--config',
		'workers/okx-chat-bot/cloudbuild.yaml',
		'--region',
		REGION,
		'--project',
		PROJECT,
		`--substitutions=${substitutions}`,
		'.',
	];
	if (DRY) {
		say(`\n  dry run: would run in ${context}:\n    gcloud ${submitArgs.join(' ')}\n`);
		return;
	}

	const before = await okxSubsystem().catch(() => null);
	say(`\n  serving now: ${before?.host || 'unknown'} (${before?.status || 'unknown'})`);

	step(5, 'build and deploy');
	if (context === WORKTREE) {
		if (existsSync(WORKTREE)) await git(['worktree', 'remove', '--force', WORKTREE]);
		await git(['worktree', 'add', '--detach', WORKTREE, 'HEAD']);
	}
	try {
		await stream('gcloud', submitArgs, { cwd: context });
	} catch {
		die('Cloud Build failed (log above). The serving revision is untouched: a failed deploy never moves traffic.');
	} finally {
		if (context === WORKTREE) await git(['worktree', 'remove', '--force', WORKTREE]).catch(() => {});
	}

	step(6, 'verify the rollout on /api/healthz');
	const { stdout: rev } = await run(
		'gcloud',
		['run', 'services', 'describe', SERVICE, '--region', REGION, '--project', PROJECT, '--format=value(status.latestReadyRevisionName)'],
		{ timeout: 60_000 },
	);
	const revision = rev.trim();
	say(`  new revision ${revision}; waiting for it to take the single-writer lease and beat`);
	const deadline = Date.now() + VERIFY_TIMEOUT_MS;
	let last = '';
	while (Date.now() < deadline) {
		const s = await okxSubsystem().catch(() => null);
		const line = s ? `${s.host} | ${s.status} | ${s.detail}` : 'healthz unreachable';
		if (line !== last) {
			say(`  ${new Date().toISOString().slice(11, 19)} ${line}`);
			last = line;
		}
		if (s?.host?.includes(revision) && (s.status === 'ok' || s.status === 'degraded')) {
			say(`\n  DEPLOYED: ${revision} holds the lease and is beating (${s.status}).`);
			if (s.status !== 'ok') say(`  Not fully green yet: ${s.detail}\n  ${s.hint || ''}`);
			say('  Lane detail: curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" \\');
			say('    https://okx-chat-bot-lp642k3kpa-uc.a.run.app/readyz | jq \'{lane: .provider.lane, chain: .provider.chain, lease: .lease}\'\n');
			return;
		}
		await new Promise((r) => setTimeout(r, 15_000));
	}
	die(
		`${revision} did not report in within ${VERIFY_TIMEOUT_MS / 60_000} minutes. Read its /readyz (lease.waitingOn names what it waits for) ` +
			`and: gcloud logging read 'resource.labels.service_name="${SERVICE}"' --freshness=30m --limit 100`,
		3,
	);
}

main().catch((err) => die(err?.message || String(err)));
