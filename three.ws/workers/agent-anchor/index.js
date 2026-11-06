// agent-anchor — autonomous market-news anchor worker (entrypoint).
//
// A long-lived cadence loop (default 90s, env ANCHOR_CADENCE_MS) that:
//   1. pulls the three real intel feeds (aixbt narrative, sentiment pulse, flow),
//   2. merges them into a compact briefing,
//   3. asks the brain to script a tight 2–4 sentence anchor read,
//   4. splits it into a lower-third headline + a spoken body,
//   5. stores the script (so viewers' browsers can speak it) and pushes the
//      headline as a type:'analysis' screen frame.
//
// Viewers on /agent-screen subscribe to the frame stream, speak the body with
// real TTS, and lip-sync the avatar to it. This process is NOT a Vercel cron —
// it holds state across ticks and runs continuously. Run: node workers/agent-anchor.
//
//   ANCHOR_CADENCE_MS   — ms between bulletins (default 90000)
//   AGENT_JWT, AGENT_ID — the anchor agent's identity (required to push)
//   ANCHOR_API_BASE     — three.ws API origin (default https://three.ws)

import { gatherBrief, scriptBulletin, publishScript } from './anchor-client.js';
import { splitScript } from './brief.js';
import { screenPush } from './screen-push.js';

const CADENCE_MS = Math.max(15_000, Number(process.env.ANCHOR_CADENCE_MS) || 90_000);
const BOOT_AT = new Date().toISOString();

// One JSON line per event to stdout/stderr — matches workers/agent-sniper/log.js
// so the worker's output drops straight into log search without a parser, and
// without tripping the no-console lint rule.
function log(level, msg, meta) {
	const line = { t: new Date().toISOString(), level, tag: 'agent-anchor', msg, ...(meta || {}) };
	const out = level === 'error' ? process.stderr : process.stdout;
	out.write(JSON.stringify(line) + '\n');
}

// Run one full bulletin: gather → script → split → publish → push. Each stage
// degrades gracefully — a dead feed narrows the read, a brain failure skips the
// tick (the previous frame's 90s TTL keeps the last bulletin on screen briefly),
// and the loop always lives to the next cadence.
async function runBulletin() {
	const brief = await gatherBrief();
	if (brief.offline.length) {
		log('info', 'feeds offline', { offline: brief.offline });
	}

	let script;
	try {
		script = await scriptBulletin(brief);
	} catch (err) {
		log('error', 'script failed', { err: err?.message });
		// Honest fallback: report the live feeds that did return rather than going
		// silent, so the wall still shows the anchor reacting to the market.
		const fallback = brief.isQuiet
			? 'Markets are quiet — no fresh narratives this cycle. Back shortly with the next bulletin.'
			: `Reading the tape: ${brief.items[0]?.headline || 'narratives developing'}.`;
		screenPush(fallback.slice(0, 120), 'analysis');
		return;
	}

	const { headline, body } = splitScript(script);
	if (!headline) {
		log('error', 'empty headline', {});
		return;
	}

	await publishScript({ headline, body, brief });
	screenPush(headline, 'analysis');
	log('info', 'on air', { headline, bodyLen: body.length, offline: brief.offline });
}

async function main() {
	log('info', 'boot', { cadenceMs: CADENCE_MS, bootAt: BOOT_AT });
	if (!process.env.AGENT_JWT || !process.env.AGENT_ID) {
		log('error', 'missing AGENT_JWT/AGENT_ID — frames will not push', {});
	}
	screenPush('On air shortly — pulling the latest market intel', 'analysis');

	let draining = false;
	let running = false;

	const tick = async () => {
		if (draining || running) return; // overlap guard — a slow brain can't stack
		running = true;
		try {
			await runBulletin();
		} catch (err) {
			log('error', 'bulletin crashed', { err: err?.message });
		} finally {
			running = false;
		}
	};

	// First bulletin immediately, then on cadence.
	await tick();
	const timer = setInterval(tick, CADENCE_MS);

	const shutdown = (signal) => {
		if (draining) return;
		draining = true;
		log('info', 'shutdown', { signal });
		clearInterval(timer);
		process.exit(0);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('unhandledRejection', (err) => log('error', 'unhandledRejection', { err: err?.message }));
}

main().catch((err) => {
	log('error', 'fatal', { err: err?.message, stack: err?.stack });
	process.exit(1);
});
