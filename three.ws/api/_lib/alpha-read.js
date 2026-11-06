// In-Character Alpha Co-pilot — the grounding + validation core (pure, no I/O).
//
// The agent's LLM persona reads a REAL live launch and returns a structured
// verdict plus a short in-character line its avatar will speak aloud. This
// module owns everything that must be deterministic and testable:
//   - buildReadPrompt:  the persona-grounded prompt, fed ONLY real signals
//   - parseReadJson:     tolerant extraction of the model's JSON object
//   - validateRead:      clamp/repair the model output against the real inputs
//                        (the anti-hallucination layer) and derive the action gate
//
// The cardinal rule (the prompt's "touching money" guardrails): the model may
// only ever speak numbers we actually fetched. validateRead re-derives the
// verdict's allowed shape, clamps any suggested size to the live spend policy +
// wallet balance, and scrubs the spoken line of fabricated figures — replacing
// it with a grounded, templated line rather than ever voicing an invented price,
// liquidity, or holder count. The UI also renders the real `signals` beside the
// read so ground truth is always visible.
//
// No I/O, no heavy imports — api/agents/alpha.js fetches the real signals and
// calls these; tests exercise them directly.

export const VERDICTS = Object.freeze(['snipe', 'watch', 'pass']);
const VERDICT_SET = new Set(VERDICTS);

// Kept above a buy so it never fails for lack of lamports to pay fees / open the
// token ATA. Mirrors SOL_FEE_HEADROOM_LAMPORTS (0.003 SOL) in agent-trade-guards.
export const SIZE_HEADROOM_SOL = 0.003;

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// ── prompt ──────────────────────────────────────────────────────────────────

/**
 * Build the persona-grounded read prompt. The model sees ONLY the real signals
 * we pass and is told, in no uncertain terms, never to invent a number.
 *
 * @param {object} o
 * @param {string} o.agentName
 * @param {string} [o.persona]   the agent's persona_prompt (its voice + risk stance)
 * @param {string} o.network
 * @param {object} o.signals     the real, fetched signal bundle (see alpha.js)
 * @param {boolean} o.owner      whether the viewer owns the wallet (size advice on)
 * @returns {{ system: string, user: string }}
 */
export function buildReadPrompt({ agentName, persona, network, signals, owner }) {
	const base = (persona || '').trim();
	const system = [
		base ? `You speak in character as ${agentName}. Persona:\n${base}\n` : `You are ${agentName}, an on-chain trading agent with a distinct voice.`,
		`You are the IN-CHARACTER ALPHA CO-PILOT for the three.ws agent "${agentName}" and its self-custodied Solana wallet (network: ${network}).`,
		`A real pump.fun launch is in front of you. You will judge it OUT LOUD, in character, and decide what you would do.`,
		``,
		`ABSOLUTE RULES (you are reasoning about real money):`,
		`• You may ONLY use the numbers in the SIGNALS JSON below. Never invent or estimate a price, liquidity, market cap, holder count, score, or percentage. If a signal is null, say it's unknown — do not guess it.`,
		`• Your "spoken_line" is read aloud by your 3D avatar: 1–3 sentences, in your voice, conversational, no markdown, no lists, no emojis. Reference at most one or two concrete signals — and only ones present in SIGNALS.`,
		`• Let your PERSONA shape the call. A cautious agent and an aggressive agent should reach different conclusions on the same data. Reason about conflicting signals honestly rather than hyping.`,
		`• This is your opinion grounded in data, NOT financial advice or a guaranteed call. Surface the real risks.`,
		`• "verdict" is one of: "snipe" (you'd take a position now), "watch" (interesting, not yet), "pass" (not for you).`,
		owner
			? `• If you say "snipe", suggest a position size in SOL that respects the wallet balance and limits in SIGNALS. Stay small and sane. If signals are thin or risky, prefer "watch" or "pass".`
			: `• You are speaking publicly (this viewer is not the owner). Do not suggest a position size; "suggested_size_sol" must be null.`,
		``,
		`Respond with ONLY a JSON object, no prose around it, exactly this shape:`,
		`{"verdict":"snipe|watch|pass","conviction":0-100,"suggested_size_sol":number|null,"risks":["short risk", ...],"cited_signals":["signal name you used", ...],"spoken_line":"what your avatar says aloud"}`,
	].join('\n');

	const user = [
		`SIGNALS (the only real data you have — every number you speak must come from here):`,
		JSON.stringify(signals, null, 2),
		``,
		`Give your in-character read as the JSON object specified. Be honest. If nothing here is compelling, say so plainly and verdict "pass".`,
	].join('\n');

	return { system, user };
}

// ── parsing ───────────────────────────────────────────────────────────────────

/** Tolerantly pull the first JSON object out of a model response. */
export function parseReadJson(text) {
	if (typeof text !== 'string' || !text.trim()) return null;
	// Fast path: clean JSON.
	try { return JSON.parse(text); } catch { /* fall through */ }
	// Strip code fences, then grab the outermost balanced {...}.
	const cleaned = text.replace(/```json|```/gi, '');
	const start = cleaned.indexOf('{');
	if (start < 0) return null;
	let depth = 0;
	for (let i = start; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) {
				try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
			}
		}
	}
	return null;
}

// ── anti-hallucination: number grounding ───────────────────────────────────────

/** Pull standalone numbers out of free text (handles 1,234 / 12.5 / 3k / 2m). */
export function extractNumbers(text) {
	if (typeof text !== 'string') return [];
	const out = [];
	// The k/m/b suffix only counts as a unit when it's standalone — a negative
	// lookahead stops "1,234 mcap" from reading the "m" of "mcap" as millions.
	const re = /(\d[\d,]*\.?\d*)\s*([kmb])?(?![a-z])/gi;
	let m;
	while ((m = re.exec(text))) {
		let n = parseFloat(m[1].replace(/,/g, ''));
		if (!Number.isFinite(n)) continue;
		const suffix = (m[2] || '').toLowerCase();
		if (suffix === 'k') n *= 1e3;
		else if (suffix === 'm') n *= 1e6;
		else if (suffix === 'b') n *= 1e9;
		out.push(n);
	}
	return out;
}

/** Every real numeric value a read is allowed to voice, plus its k / m forms. */
export function collectSignalNumbers(signals, extra = []) {
	const vals = new Set();
	const add = (v) => {
		const n = num(v);
		if (n == null) return;
		vals.add(Math.abs(n));
		vals.add(Math.abs(Math.round(n)));
		if (Math.abs(n) >= 1000) { vals.add(Math.round(Math.abs(n) / 1e3)); vals.add(Math.round(Math.abs(n) / 1e3) * 1e3); }
		if (Math.abs(n) >= 1e6) { vals.add(Math.round(Math.abs(n) / 1e6)); vals.add(Math.round(Math.abs(n) / 1e6) * 1e6); }
	};
	const walk = (o) => {
		if (o == null) return;
		if (typeof o === 'number') return add(o);
		if (Array.isArray(o)) return o.forEach(walk);
		if (typeof o === 'object') return Object.values(o).forEach(walk);
	};
	walk(signals);
	extra.forEach(add);
	return vals;
}

const GROUNDING_TOLERANCE = 0.04; // 4% — a spoken "≈72" still matches a 72.3 score

function matchesAllowed(n, allowed) {
	const a = Math.abs(n);
	if (allowed.has(a) || allowed.has(Math.round(a))) return true;
	for (const v of allowed) {
		if (v === 0) { if (a === 0) return true; continue; }
		if (Math.abs(a - v) / Math.abs(v) <= GROUNDING_TOLERANCE) return true;
	}
	return false;
}

/**
 * Flag any specific number in the spoken line / risks that does not trace to a
 * real signal. Small integers (≤ 12 — "two risk flags", "3 wallets", a year-ish
 * count) and bare years pass; large or precise unmatched figures are suspicious.
 * @returns {{ ok: boolean, suspicious: number[] }}
 */
export function checkGrounding(texts, allowed) {
	const suspicious = [];
	for (const t of texts) {
		for (const n of extractNumbers(t)) {
			if (Math.abs(n) <= 12 && Number.isInteger(n)) continue; // benign small counts
			if (matchesAllowed(n, allowed)) continue;
			suspicious.push(n);
		}
	}
	return { ok: suspicious.length === 0, suspicious };
}

// ── size clamping ──────────────────────────────────────────────────────────────

/**
 * Clamp a model-suggested position size to the live spend policy AND wallet
 * balance. Returns a safe number (≥ 0) or null when no size applies. Execution
 * still re-checks server-side; this is the advisory clamp shown to the owner.
 */
export function clampSize(suggested, { perTradeSol = null, balanceSol = null, dailyBudgetSol = null, dailySpentSol = 0 } = {}) {
	let s = num(suggested);
	if (s == null || s <= 0) return null;
	if (perTradeSol != null) s = Math.min(s, perTradeSol);
	if (dailyBudgetSol != null) s = Math.min(s, Math.max(0, dailyBudgetSol - (num(dailySpentSol) || 0)));
	if (balanceSol != null) s = Math.min(s, Math.max(0, balanceSol - SIZE_HEADROOM_SOL));
	if (!(s > 0)) return 0;
	return round4(s);
}

// ── validation + gate ───────────────────────────────────────────────────────────

/** A deterministic, grounded line to speak when the model's line is unusable. */
export function templatedSpokenLine(verdict, agentName, signals) {
	const sym = signals?.symbol ? `$${signals.symbol}` : 'this launch';
	if (verdict === 'snipe') return `I like what I'm seeing on ${sym}. The signals line up for me — I'd take a small position here.`;
	if (verdict === 'pass') return `I'm passing on ${sym}. The data in front of me doesn't earn a position right now.`;
	return `${sym} is worth watching, but I'm not convinced yet — I want cleaner signals before I commit.`;
}

function cleanLine(s) {
	if (typeof s !== 'string') return '';
	return s.replace(/\s+/g, ' ').replace(/[*_`#>]/g, '').trim().slice(0, 360);
}

/**
 * Repair + ground the raw model output against the real signals, and derive the
 * owner action gate. Pure — caller supplies the live wallet/limit context.
 *
 * @param {object} o
 * @param {object|null} o.raw        parsed model JSON (or null on parse failure)
 * @param {object} o.signals         the real signal bundle
 * @param {string} o.agentName
 * @param {boolean} o.owner
 * @param {object} [o.context]       { balanceSol, perTradeSol, dailyBudgetSol, dailySpentSol, killSwitch, frozen }
 * @returns {{ read: object, gate: object }}
 */
export function validateRead({ raw, signals, agentName, owner, context = {} }) {
	const r = raw && typeof raw === 'object' ? raw : {};

	let verdict = typeof r.verdict === 'string' ? r.verdict.toLowerCase().trim() : '';
	if (!VERDICT_SET.has(verdict)) verdict = 'watch';

	let conviction = num(r.conviction);
	conviction = conviction == null ? 50 : Math.max(0, Math.min(100, Math.round(conviction)));

	const risks = Array.isArray(r.risks)
		? r.risks.map(cleanLine).filter(Boolean).slice(0, 5)
		: [];
	const citedSignals = Array.isArray(r.cited_signals)
		? r.cited_signals.map((s) => cleanLine(String(s))).filter(Boolean).slice(0, 6)
		: [];

	// Size only ever applies to the owner on a "snipe", and is clamped to policy.
	let suggestedSize = null;
	if (owner && verdict === 'snipe') {
		suggestedSize = clampSize(r.suggested_size_sol, {
			perTradeSol: num(context.perTradeSol),
			balanceSol: num(context.balanceSol),
			dailyBudgetSol: num(context.dailyBudgetSol),
			dailySpentSol: num(context.dailySpentSol) || 0,
		});
	}

	// Number grounding: never voice a fabricated figure. Allowed = every real
	// signal value plus the (already-grounded) conviction and clamped size.
	const allowed = collectSignalNumbers(signals, [conviction, suggestedSize]);
	let spokenLine = cleanLine(r.spoken_line);
	const grounding = checkGrounding([spokenLine, ...risks], allowed);
	let guardOk = grounding.ok && !!spokenLine;
	if (!guardOk) spokenLine = templatedSpokenLine(verdict, agentName, signals);

	const read = {
		verdict,
		conviction,
		suggested_size_sol: suggestedSize,
		risks,
		cited_signals: citedSignals,
		spoken_line: spokenLine,
		hallucination_guard: {
			ok: guardOk,
			// What we caught + did about it, so the UI can show the honest note.
			suspicious_numbers: grounding.suspicious,
			line_replaced: !guardOk,
		},
	};

	const gate = deriveGate({ owner, verdict, suggestedSize, signals, context });
	return { read, gate };
}

/**
 * The advisory action gate shown to the owner. Mirrors the trade-guard
 * predicates so the UI never offers an action the server would reject — but the
 * server (executeAgentTrade → /solana/trade) remains the source of truth and
 * re-checks every guard at execution time.
 */
export function deriveGate({ owner, verdict, suggestedSize, signals, context = {} }) {
	if (!owner) return { can_act: false, reason: 'not_owner', message: 'Sign in as the owner to act on this read.' };
	if (verdict !== 'snipe') return { can_act: false, reason: 'not_actionable', message: `${agentVerb(verdict)} — nothing to execute.` };
	if (context.frozen) return { can_act: false, reason: 'wallet_frozen', message: 'Wallet is frozen. Unfreeze it under Limits & Safety to act.' };
	if (context.killSwitch) return { can_act: false, reason: 'kill_switch', message: 'Trading is paused (kill switch). Re-enable it to act.' };
	if (!(suggestedSize > 0)) {
		const bal = num(context.balanceSol);
		if (bal != null && bal <= SIZE_HEADROOM_SOL) return { can_act: false, reason: 'insufficient_sol', message: 'Fund the agent wallet to act on a snipe.' };
		return { can_act: false, reason: 'no_size', message: 'No sane position size fits the current limits — adjust limits or fund the wallet.' };
	}
	return {
		can_act: true,
		reason: 'ok',
		message: `Ready to buy ◎${suggestedSize} SOL — confirm to execute within your limits.`,
		size_sol: suggestedSize,
	};
}

function agentVerb(verdict) {
	if (verdict === 'pass') return 'Passing on this one';
	return 'Watching, not buying yet';
}
