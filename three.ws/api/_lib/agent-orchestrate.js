// Multi-agent goal orchestration.
//
// A LEAD agent is handed one goal. It decomposes the goal into sub-tasks, then
// either DELEGATES a sub-task to a teammate agent (a free LLM turn) or HIRES a
// provider agent for a paid skill over the real x402 rails — every hire bounded
// by a per-node slice of the goal's hard USD cap and stamped with a real on-chain
// invocation receipt. As each node transitions queued → running → done | failed,
// the full current task tree is emitted so a live surface can paint it.
//
// This module is split into PURE shaping helpers (plan parsing, tree building,
// budget splitting, transition application — all unit-tested with no chain/LLM)
// and one impure orchestrator that wires real delegation + hire dependencies in.
// The orchestrator takes its side-effecting work as injected `deps`, so the same
// control flow is exercised in tests with fakes and in production with the real
// `runAgentDelegation` + `executeHire` paths.

import { randomUUID } from 'node:crypto';

// Recursion is bounded by construction: a delegated turn runs a single LLM
// completion with no tool access (see api/_lib/agent-delegate.js), so a sub-agent
// can never itself orchestrate. The tree is therefore always exactly two levels —
// one lead, its direct children. We never spawn deeper than this.
export const MAX_SUBTASKS = 8;
export const DEFAULT_MAX_USD = 1.0;
export const HARD_MAX_USD = 5.0;

// ── pure: plan parsing ───────────────────────────────────────────────────────

// Pull the first balanced JSON object out of an LLM response. The lead is asked
// for raw JSON, but models wrap it in prose or ```json fences — tolerate both by
// scanning for the first `{` and matching braces (string-aware so a `}` inside a
// quoted value doesn't close the object early). Returns the parsed object or null.
export function extractPlanJson(text) {
	if (typeof text !== 'string') return null;
	const start = text.indexOf('{');
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === '\\') esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) {
				const slice = text.slice(start, i + 1);
				try {
					return JSON.parse(slice);
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

// Normalize a raw plan object into a clean, bounded sub-task list. Unknown kinds
// collapse to 'delegate'; a 'hire' whose serviceSlug isn't in the live catalog is
// downgraded to a 'delegate' (never let the lead invent a payable slug). Delegate
// targets default to the lead itself when no teammate id is given. Caps the count
// so one plan can't fan out unboundedly into paid inference.
export function normalizePlan(raw, { leadAgentId, allowedSlugs = [], maxSubtasks = MAX_SUBTASKS } = {}) {
	const allowed = allowedSlugs instanceof Set ? allowedSlugs : new Set(allowedSlugs);
	const list = Array.isArray(raw?.subtasks) ? raw.subtasks : Array.isArray(raw) ? raw : [];
	const out = [];
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const title = String(item.title || item.task || item.name || '').trim().slice(0, 200);
		if (!title) continue;
		let kind = item.kind === 'hire' ? 'hire' : 'delegate';
		let serviceSlug = typeof item.serviceSlug === 'string' ? item.serviceSlug.trim() : null;
		if (kind === 'hire' && (!serviceSlug || !allowed.has(serviceSlug))) {
			// Hallucinated or unavailable offer — keep the work, do it for free.
			kind = 'delegate';
			serviceSlug = null;
		}
		const node = {
			title,
			kind,
			instruction: String(item.instruction || item.prompt || title).trim().slice(0, 4000),
		};
		if (kind === 'hire') {
			node.serviceSlug = serviceSlug;
			node.input = item.input && typeof item.input === 'object' ? item.input : null;
		} else {
			node.agentId =
				typeof item.agentId === 'string' && item.agentId.trim() ? item.agentId.trim() : leadAgentId;
		}
		out.push(node);
		if (out.length >= maxSubtasks) break;
	}
	return out;
}

// ── pure: budget splitting ───────────────────────────────────────────────────

// Split the goal's USD cap evenly across the HIRE nodes, floored to whole cents so
// the sum can never exceed the total. Free (delegate) nodes cost nothing and get
// null. Returns an array aligned to `subtasks`. With no hire nodes every slice is
// null; the platform x402 spend-guard re-checks each slice again at hire time, so
// this is a budgeting hint, never the only ceiling.
export function splitBudget(subtasks, maxUsd) {
	const cap = clampBudget(maxUsd);
	const hireCount = subtasks.filter((s) => s.kind === 'hire').length;
	if (hireCount === 0) return subtasks.map(() => null);
	const perNodeCents = Math.floor((cap * 100) / hireCount);
	const perNode = perNodeCents / 100;
	return subtasks.map((s) => (s.kind === 'hire' ? perNode : null));
}

export function clampBudget(maxUsd) {
	const n = Number(maxUsd);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_USD;
	return Math.min(n, HARD_MAX_USD);
}

// ── pure: tree building + transitions ────────────────────────────────────────

// Assemble the initial task tree: a lead node plus one child per sub-task, every
// child queued, with its budget slice attached. Edges fan out from the lead. This
// is the snapshot shape the live graph renders and every transition mutates.
export function buildTaskTree({ taskId, leadAgentId, leadName = null, goal, maxUsd, subtasks }) {
	const cap = clampBudget(maxUsd);
	const slices = splitBudget(subtasks, cap);
	const nodes = [
		{
			id: 'lead',
			agentId: leadAgentId,
			name: leadName,
			kind: 'lead',
			title: goal,
			status: 'running',
			result: null,
			error: null,
		},
	];
	const edges = [];
	subtasks.forEach((s, i) => {
		const id = `n${i}`;
		nodes.push({
			id,
			agentId: s.kind === 'delegate' ? s.agentId : null,
			name: null,
			kind: s.kind,
			title: s.title,
			// Carried for execution (the delegate message / hire input); stripped
			// from the compact graph snapshot that reaches the client.
			instruction: s.instruction || s.title,
			input: s.kind === 'hire' ? (s.input || null) : null,
			serviceSlug: s.serviceSlug || null,
			status: 'queued',
			maxUsd: slices[i],
			costUsd: null,
			signature: null,
			explorerUrl: null,
			result: null,
			error: null,
		});
		edges.push({ from: 'lead', to: id });
	});
	return {
		taskId,
		goal,
		leadAgentId,
		maxUsd: cap,
		status: 'running',
		nodes,
		edges,
		budgetSpentUsd: 0,
	};
}

// Return a NEW tree with `patch` merged into the node `nodeId`. Pure: callers get
// a fresh object they can emit as an immutable snapshot without aliasing prior
// emissions. Recomputes the aggregate budget spent and the overall task status.
export function applyTransition(tree, nodeId, patch) {
	const nodes = tree.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
	const budgetSpentUsd = nodes.reduce((sum, n) => sum + (Number(n.costUsd) || 0), 0);
	const children = nodes.filter((n) => n.id !== 'lead');
	let status = tree.status;
	if (status !== 'planning') {
		const settled = children.every((n) => n.status === 'done' || n.status === 'failed');
		const lead = nodes.find((n) => n.id === 'lead');
		if (settled && lead && (lead.status === 'done' || lead.status === 'failed')) {
			status = children.some((n) => n.status === 'failed') || lead.status === 'failed'
				? 'completed_with_errors'
				: 'done';
		}
	}
	return { ...tree, nodes, edges: tree.edges, budgetSpentUsd, status };
}

// A holder-readable narration line for a node transition — drives the lead's
// activity log ("Hired Kestrel for sentiment-scan — paid $0.02, receipt 5xR…").
export function narrateNode(node) {
	const name = node.title || node.kind;
	if (node.kind === 'hire') {
		if (node.status === 'running') return `Hiring a teammate for ${truncate(name, 60)}…`;
		if (node.status === 'done') {
			const cost = node.costUsd != null ? ` — paid $${Number(node.costUsd).toFixed(2)}` : '';
			const sig = node.signature ? `, receipt ${truncate(node.signature, 8)}` : '';
			return `Hired teammate for ${truncate(name, 50)}${cost}${sig}`;
		}
		if (node.status === 'failed') return `Hire skipped for ${truncate(name, 50)} — ${node.error || 'unavailable'}`;
	}
	if (node.status === 'running') return `Delegating: ${truncate(name, 70)}…`;
	if (node.status === 'done') return `Completed: ${truncate(name, 70)}`;
	if (node.status === 'failed') return `Sub-task failed: ${truncate(name, 50)} — ${node.error || 'error'}`;
	return `Queued: ${truncate(name, 70)}`;
}

function truncate(s, n) {
	const str = String(s ?? '');
	return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// The instruction handed to the lead to produce a structured plan. Lists the live,
// hireable services so the lead can pick a real serviceSlug instead of inventing
// one. Asks for raw JSON; extractPlanJson tolerates fences/prose around it.
export function planningPrompt(goal, { catalog = [], maxSubtasks = MAX_SUBTASKS } = {}) {
	const services = catalog.slice(0, 20).map((c) => `  - "${c.slug}": ${c.name}${c.description ? ` — ${String(c.description).slice(0, 80)}` : ''} ($${Number(c.price_usdc || 0).toFixed(2)})`).join('\n');
	const catalogBlock = services
		? `\nHireable teammate services (use the exact slug for a "hire"):\n${services}\n`
		: '\nNo paid teammate services are available right now — use "delegate" for every sub-task.\n';
	return `You are a lead agent. Break this goal into at most ${maxSubtasks} concrete sub-tasks and decide, for each, whether to DELEGATE it (you or a teammate does it as a reasoning step — kind "delegate") or HIRE a paid teammate service (kind "hire" with a serviceSlug from the list).

GOAL: ${goal}
${catalogBlock}
Reply with ONLY a JSON object of this exact shape, no prose:
{"subtasks":[{"title":"short label","kind":"delegate","instruction":"what to do"},{"title":"short label","kind":"hire","serviceSlug":"exact-slug","input":{}}]}`;
}

// The instruction to synthesize the finished sub-results into a final answer.
export function synthesisPrompt(goal, results) {
	const body = results
		.map((r, i) => `[${i + 1}] ${r.title}\n${truncate(r.result || r.error || '(no result)', 1200)}`)
		.join('\n\n');
	return `You are the lead agent. You delegated this goal and your team returned the results below. Synthesize them into one clear, final answer for the user.

GOAL: ${goal}

TEAM RESULTS:
${body}

Write the final answer now.`;
}

// ── impure: orchestrate ──────────────────────────────────────────────────────

/**
 * Run a goal end to end across a lead agent and its team, emitting the full task
 * tree on every transition.
 *
 * @param {object} params
 * @param {string} params.userId        - authenticated owner of the lead agent
 * @param {string} params.leadAgentId   - the lead
 * @param {string} [params.leadName]
 * @param {string} params.goal
 * @param {number} [params.maxUsd]       - hard cap on total spend (clamped)
 * @param {Array}  [params.catalog]      - live hireable services for the lead to pick from
 * @param {(tree: object, ctx: object) => void} [params.emit] - called with each snapshot
 * @param {number} [params.deadlineMs]   - absolute epoch-ms budget; once passed, no new
 *                                         node or synthesis turn starts and the current
 *                                         (partial) tree is returned. Defaults to no limit.
 * @param {object} [deps]                - injectable side effects (tests pass fakes)
 * @param {Function} deps.runDelegate    - ({toAgentId,message}) => Promise<{response}>
 * @param {Function} deps.runHire        - ({hirerAgentId,serviceSlug,input,maxUsd}) => Promise<{hire}>
 * @param {Function} [deps.makeTaskId]
 * @returns {Promise<object>} the final task tree
 */
export async function orchestrateGoal(
	{ userId, leadAgentId, leadName = null, goal, maxUsd = DEFAULT_MAX_USD, catalog = [], emit = () => {}, deadlineMs = Infinity },
	deps = {},
) {
	const runDelegate = deps.runDelegate;
	const runHire = deps.runHire;
	const makeTaskId = deps.makeTaskId || (() => randomUUID());
	if (typeof runDelegate !== 'function') throw new Error('runDelegate dependency is required');
	if (typeof runHire !== 'function') throw new Error('runHire dependency is required');

	const cap = clampBudget(maxUsd);
	const taskId = makeTaskId();

	// Planning phase: a single lead node while decomposition runs.
	let tree = {
		taskId,
		goal,
		leadAgentId,
		maxUsd: cap,
		status: 'planning',
		nodes: [{ id: 'lead', agentId: leadAgentId, name: leadName, kind: 'lead', title: goal, status: 'planning', result: null, error: null }],
		edges: [],
		budgetSpentUsd: 0,
	};
	const fire = (ctx = {}) => emit(tree, ctx);
	fire({ phase: 'planning', narration: `Planning: ${truncate(goal, 80)}`, narrateAgentId: leadAgentId });

	// Ask the lead for a structured plan.
	let subtasks = [];
	try {
		const planRes = await runDelegate({ toAgentId: leadAgentId, message: planningPrompt(goal, { catalog }) });
		const parsed = extractPlanJson(planRes?.response || planRes?.text || '');
		subtasks = normalizePlan(parsed, {
			leadAgentId,
			allowedSlugs: catalog.map((c) => c.slug),
		});
	} catch (err) {
		// Planning failed outright — the lead handles the goal solo as a single node.
		tree = applyTransition(
			{ ...buildTaskTree({ taskId, leadAgentId, leadName, goal, maxUsd: cap, subtasks: [] }), status: 'running' },
			'lead',
			{ status: 'failed', error: planErrorMessage(err) },
		);
		fire({ phase: 'plan_failed', narration: `Planning failed — ${planErrorMessage(err)}`, narrateAgentId: leadAgentId });
		return tree;
	}

	// Build the tree with queued children and emit the populated plan.
	tree = buildTaskTree({ taskId, leadAgentId, leadName, goal, maxUsd: cap, subtasks });
	fire({ phase: 'planned', narration: subtasks.length
		? `Split into ${subtasks.length} sub-task${subtasks.length === 1 ? '' : 's'}`
		: 'Handling this goal solo', narrateAgentId: leadAgentId });

	// Execute each sub-task in order. One node failing never aborts the team.
	const childNodes = tree.nodes.filter((n) => n.id !== 'lead');
	const completed = [];
	for (const child of childNodes) {
		// Time budget: once the orchestration deadline passes, stop starting new
		// nodes. Mark this node and every still-queued sibling as skipped so the
		// tree returns a truthful partial result — a real, paid multi-agent run can
		// legitimately outlast the serverless wall, and a clean partial beats a 504.
		if (Date.now() >= deadlineMs) {
			for (const rest of childNodes) {
				const cur = tree.nodes.find((n) => n.id === rest.id);
				if (cur && cur.status === 'queued') {
					tree = applyTransition(tree, rest.id, { status: 'failed', error: 'skipped — team ran out of time' });
					fire({ phase: 'node_settled', node: tree.nodes.find((n) => n.id === rest.id), narration: `Skipped ${truncate(rest.title, 50)} — ran out of time`, narrateAgentId: leadAgentId });
				}
			}
			break;
		}

		// running
		tree = applyTransition(tree, child.id, { status: 'running' });
		const running = tree.nodes.find((n) => n.id === child.id);
		fire({ phase: 'node_running', node: running, narration: narrateNode(running), narrateAgentId: leadAgentId });

		try {
			if (child.kind === 'hire') {
				const remaining = cap - tree.budgetSpentUsd;
				const slice = Math.max(0, Math.min(child.maxUsd ?? remaining, remaining));
				const out = await runHire({
					userId,
					hirerAgentId: leadAgentId,
					serviceSlug: child.serviceSlug,
					input: child.input || null,
					maxUsd: round2(slice),
				});
				const hire = out?.hire || out || {};
				const patch = {
					status: 'done',
					agentId: hire.provider_agent_id || hire.provider?.id || null,
					name: hire.provider?.name || null,
					costUsd: hire.usd != null ? Number(hire.usd) : null,
					signature: hire.invocation_signature || hire.payment_signature || null,
					explorerUrl: hire.invocation_explorer || hire.payment_explorer || null,
					result: out?.result != null ? summarize(out.result) : hire.result_summary || null,
				};
				tree = applyTransition(tree, child.id, patch);
			} else {
				const out = await runDelegate({ toAgentId: child.agentId, message: child.instruction });
				tree = applyTransition(tree, child.id, {
					status: 'done',
					result: summarize(out?.response || out?.text || ''),
				});
			}
		} catch (err) {
			tree = applyTransition(tree, child.id, { status: 'failed', error: nodeErrorMessage(err) });
		}
		const settled = tree.nodes.find((n) => n.id === child.id);
		completed.push(settled);
		fire({ phase: 'node_settled', node: settled, narration: narrateNode(settled), narrateAgentId: leadAgentId });
	}

	// Synthesis: the lead folds the sub-results into a final answer. If there were
	// no sub-tasks the lead simply answers the goal itself. Skip this final turn if
	// we've already hit the deadline — one more LLM round-trip could push the
	// handler past its serverless limit; the completed sub-results still stand.
	if (Date.now() >= deadlineMs) {
		tree = applyTransition(tree, 'lead', {
			status: 'done',
			result: null,
			error: 'partial result — the team ran out of time before the final summary',
		});
		fire({ phase: 'done', narration: 'Team task returned a partial result — ran out of time', narrateAgentId: leadAgentId });
		return tree;
	}
	try {
		const synthMsg = childNodes.length
			? synthesisPrompt(goal, completed.map((c) => ({ title: c.title, result: c.result, error: c.error })))
			: goal;
		const finalRes = await runDelegate({ toAgentId: leadAgentId, message: synthMsg });
		tree = applyTransition(tree, 'lead', { status: 'done', result: summarize(finalRes?.response || finalRes?.text || '') });
	} catch (err) {
		// Sub-results still stand even if the final synthesis turn fails.
		tree = applyTransition(tree, 'lead', { status: 'done', result: null, error: `synthesis unavailable: ${nodeErrorMessage(err)}` });
	}
	fire({ phase: 'done', narration: 'Team task complete', narrateAgentId: leadAgentId });
	return tree;
}

function round2(n) {
	return Math.round((Number(n) || 0) * 100) / 100;
}

function summarize(v) {
	if (v == null) return null;
	const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
	return s.slice(0, 2000);
}

function planErrorMessage(err) {
	const code = err?.code;
	if (code === 'llm_unavailable') return 'the lead agent is unavailable right now';
	return truncate(err?.message || 'planning error', 120);
}

function nodeErrorMessage(err) {
	// HireError carries a holder-readable message + code; surface it directly.
	if (err?.code === 'over_cap') return 'budget exceeded';
	if (err?.code === 'spend_disabled') return 'agent spending disabled';
	if (err?.code === 'offer_unavailable' || err?.code === 'offer_not_found') return 'provider unavailable';
	if (err?.code === 'no_wallet') return 'no wallet to pay from';
	return truncate(err?.message || 'error', 120);
}
