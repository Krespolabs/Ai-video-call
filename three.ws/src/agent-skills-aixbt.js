/**
 * aixbt intelligence skills
 * -------------------------
 * Lets a three.ws avatar tap aixbt's live market intelligence — narrative intel
 * and momentum-ranked projects — then speak a concise read in-world. This is the
 * three.ws ⇄ aixbt bridge surfaced as agent behaviour: the avatar reacts to real
 * feeds the same way builders consume the aixbt API.
 *
 * Backed by /api/aixbt/* (the aixbt API key stays server-side). When aixbt is
 * not configured the endpoint returns a 503 the handler turns into an honest,
 * actionable message — never fabricated signals.
 */

import { log } from './shared/log.js';

const BASE = '/api/aixbt';

async function getJson(path) {
	const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
	const body = await res.json().catch(() => null);
	if (!res.ok || !body || body.error) {
		const code = body?.error || `http_${res.status}`;
		const msg = body?.error_description || `aixbt request failed (${res.status})`;
		const err = new Error(msg);
		err.code = code;
		err.setup = body?.setup;
		throw err;
	}
	return body;
}

function notConfiguredMessage(err) {
	if (err?.code !== 'aixbt_not_configured') return null;
	return {
		success: false,
		output:
			"aixbt isn't connected yet on this deployment. Once an aixbt API key is set, I can pull live narrative intel and momentum scans for you.",
		sentiment: -0.1,
		data: { code: err.code, setup: err.setup },
	};
}

export function registerAixbtSkills(agentSkills) {
	// ── aixbt-intel ───────────────────────────────────────────────────────
	agentSkills.register({
		name: 'aixbt-intel',
		description: 'Pull the latest aixbt narrative intelligence and read the top items',
		instruction:
			'Fetch recent aixbt intel, optionally filtered by chain or category, and summarise the strongest signals out loud.',
		animationHint: 'think',
		voicePattern: 'Pulling the latest from aixbt...',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'How many intel items to scan (default 5).' },
				chain: { type: 'string', description: 'Filter to a chain (solana, base, ethereum, …).' },
				category: { type: 'string', description: 'Filter to a single intel category.' },
			},
		},
		handler: async (args = {}) => {
			const limit = Math.min(Math.max(1, Number(args.limit) || 5), 25);
			try {
				const params = new URLSearchParams({ limit: String(limit) });
				if (args.chain) params.set('chain', args.chain);
				if (args.category) params.set('category', args.category);
				const { intel = [] } = await getJson(`/intel?${params}`);

				if (!intel.length) {
					return {
						success: true,
						output: 'aixbt has no fresh intel matching that filter right now. Try a broader chain or category.',
						sentiment: 0,
						data: { intel: [] },
					};
				}

				const top = intel.slice(0, 3);
				const lines = top.map((i) => {
					const who = i.ticker ? `$${i.ticker}` : i.project || i.category || 'market';
					return `${who}: ${i.description}`;
				});
				const output = `aixbt is tracking ${intel.length} signal${intel.length === 1 ? '' : 's'}. Top reads — ${lines.join(' · ')}`;
				return { success: true, output, sentiment: 0.4, data: { intel } };
			} catch (err) {
				const nc = notConfiguredMessage(err);
				if (nc) return nc;
				log.error('aixbt-intel failed:', err);
				return { success: false, output: `Couldn't reach aixbt intel: ${err.message}`, sentiment: -0.3 };
			}
		},
	});

	// ── aixbt-scan ────────────────────────────────────────────────────────
	agentSkills.register({
		name: 'aixbt-scan',
		description: 'Scan aixbt momentum-ranked projects and read the movers',
		instruction:
			'Fetch aixbt momentum projects, optionally filtered by chain or names, and call out the highest-momentum movers with their 24h change.',
		animationHint: 'present',
		voicePattern: 'Scanning aixbt momentum...',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'How many projects to scan (default 5).' },
				names: { type: 'string', description: 'Comma-separated names/tickers to filter to.' },
				chain: { type: 'string', description: 'Filter to a chain (solana, base, ethereum, …).' },
			},
		},
		handler: async (args = {}) => {
			const limit = Math.min(Math.max(1, Number(args.limit) || 5), 25);
			try {
				const params = new URLSearchParams({ limit: String(limit) });
				if (args.names) params.set('names', args.names);
				if (args.chain) params.set('chain', args.chain);
				const { projects = [] } = await getJson(`/projects?${params}`);

				if (!projects.length) {
					return {
						success: true,
						output: 'aixbt has no projects matching that filter right now.',
						sentiment: 0,
						data: { projects: [] },
					};
				}

				const top = projects.slice(0, 3);
				const lines = top.map((p) => {
					const tag = p.ticker ? `$${p.ticker}` : p.name || 'unknown';
					const chg = p.market?.change_24h;
					const chgStr = chg == null ? '' : ` (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% 24h)`;
					return `${tag}${chgStr}`;
				});
				const avgChange = top
					.map((p) => p.market?.change_24h)
					.filter((c) => c != null);
				const sentiment = avgChange.length
					? Math.max(-1, Math.min(1, avgChange.reduce((a, b) => a + b, 0) / avgChange.length / 50))
					: 0.2;
				const output = `aixbt momentum — ${lines.join(', ')}.`;
				return { success: true, output, sentiment, data: { projects } };
			} catch (err) {
				const nc = notConfiguredMessage(err);
				if (nc) return nc;
				log.error('aixbt-scan failed:', err);
				return { success: false, output: `Couldn't reach aixbt momentum: ${err.message}`, sentiment: -0.3 };
			}
		},
	});
}
