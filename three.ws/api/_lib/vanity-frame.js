// Server-side frame renderer for the live Vanity Address Miner (feature #11).
//
// Each progress sample from the real grind is turned into one PNG frame here
// (SVG → PNG via sharp, already a project dependency) and pushed to
// /api/agent-screen-push, which the agent-screen canvas renders live. There is
// no browser/canvas in this path — keys never touch a client — so the visual is
// composed as SVG and rasterised on the server.
//
// Two frame kinds:
//   renderGrindFrame  — the spinning keyspace counter + attempts/sec + the
//                       expected-iterations probability ring + flickering
//                       candidate addresses (the suspense state).
//   renderRevealFrame — the MATCH moment: the winning PUBLIC address resolving
//                       character-by-character (the secret is NEVER rendered).

import sharp from 'sharp';
import { abbrev } from './vanity-grind-stats.js';

const W = 1280;
const H = 720;
const BG = '#080a0f';
const ACCENT = '#5eead4'; // teal — the brand grind colour
const DIM = '#3a4150';
const TEXT = '#e7ecf3';

// Escape the handful of chars that would break out of SVG text/attribute context.
function esc(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Deterministic pseudo-random in [0,1) from an integer seed — used only for the
// cosmetic flicker of candidate rows, never for any key material. No Math.random
// (kept reproducible so identical state renders an identical frame).
function jitter(seed) {
	const x = Math.sin(seed * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

// A circular progress ring (probability-of-completion indicator). progress is
// clamped 0..1 by the caller; we draw the swept arc plus a soft track.
function ringSvg(cx, cy, r, progress, color) {
	const p = Math.max(0, Math.min(1, progress));
	const C = 2 * Math.PI * r;
	const dash = C * p;
	return (
		`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${DIM}" stroke-width="10" opacity="0.5"/>` +
		`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="10" ` +
		`stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${(C - dash).toFixed(1)}" ` +
		`transform="rotate(-90 ${cx} ${cy})"/>`
	);
}

async function svgToDataUrl(svg) {
	const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
	return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * The suspense / populated state.
 * @param {object} s
 * @param {string} s.prefix
 * @param {string} [s.suffix]
 * @param {number} s.iterations
 * @param {number} s.attemptsPerSec
 * @param {number} s.expectedIterations
 * @param {number} s.progress            0..1 probability indicator
 * @param {number|null} [s.etaSec]
 * @param {string[]} [s.candidates]      recent candidate addresses for texture
 * @param {string} [s.agentName]
 * @returns {Promise<string>} PNG data URL
 */
export async function renderGrindFrame(s) {
	const prefix = esc(s.prefix || '');
	const suffix = s.suffix ? esc(s.suffix) : '';
	const pattern = suffix ? `${prefix}…${suffix}` : `${prefix}…`;
	const iters = abbrev(s.iterations);
	const rate = abbrev(s.attemptsPerSec);
	const expected = abbrev(s.expectedIterations);
	const pct = Math.round(Math.max(0, Math.min(1, s.progress || 0)) * 100);
	const eta = s.etaSec != null && Number.isFinite(s.etaSec)
		? (s.etaSec >= 60 ? `~${Math.round(s.etaSec / 60)}m to expectation` : `~${Math.round(s.etaSec)}s to expectation`)
		: 'past expectation — still searching';

	// Flickering candidate rows: real recent candidate addresses, each with the
	// matched-so-far head tinted and the rest dimmed, jittering position.
	const candidates = (s.candidates || []).slice(-6);
	const rows = candidates
		.map((addr, idx) => {
			const y = 360 + idx * 40;
			const dx = (jitter(s.iterations + idx) - 0.5) * 8;
			const head = esc(addr.slice(0, Math.max(1, prefix.length)));
			const rest = esc(addr.slice(Math.max(1, prefix.length), 28));
			const op = 0.28 + idx * 0.1;
			return (
				`<text x="${90 + dx}" y="${y}" font-family="monospace" font-size="22" opacity="${op}">` +
				`<tspan fill="${ACCENT}">${head}</tspan><tspan fill="${DIM}">${rest}…</tspan></text>`
			);
		})
		.join('');

	const ringCx = 1030;
	const ringCy = 360;
	const ringR = 150;

	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
		`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
		`<stop offset="0" stop-color="#0b0f17"/><stop offset="1" stop-color="#080a0f"/></linearGradient></defs>` +
		`<rect width="${W}" height="${H}" fill="url(#g)"/>` +
		// header
		`<text x="90" y="120" font-family="monospace" font-size="20" fill="${DIM}" letter-spacing="3">VANITY GRINDER</text>` +
		`<text x="90" y="180" font-family="monospace" font-size="56" fill="${TEXT}">grinding <tspan fill="${ACCENT}">${pattern}</tspan></text>` +
		// big live counter
		`<text x="90" y="280" font-family="monospace" font-size="84" font-weight="bold" fill="${TEXT}">${iters}</text>` +
		`<text x="90" y="320" font-family="monospace" font-size="26" fill="${ACCENT}">${rate}/sec · expected ~${expected}</text>` +
		// candidate flicker
		rows +
		// ring + labels
		ringSvg(ringCx, ringCy, ringR, s.progress || 0, ACCENT) +
		`<text x="${ringCx}" y="${ringCy - 6}" text-anchor="middle" font-family="monospace" font-size="52" font-weight="bold" fill="${TEXT}">${pct}%</text>` +
		`<text x="${ringCx}" y="${ringCy + 34}" text-anchor="middle" font-family="monospace" font-size="18" fill="${DIM}">of expected</text>` +
		`<text x="${ringCx}" y="${ringCy + ringR + 50}" text-anchor="middle" font-family="monospace" font-size="18" fill="${DIM}">${esc(eta)}</text>` +
		// footer
		`<text x="90" y="660" font-family="monospace" font-size="18" fill="${DIM}">${esc(s.agentName || 'agent')} · real ed25519 keyspace search — every number is a real attempt</text>` +
		`</svg>`;

	return svgToDataUrl(svg);
}

/**
 * The MATCH reveal. Renders the winning PUBLIC address with `revealed` leading
 * characters resolved and the remainder still scrambling. The secret key is
 * never passed in here and never rendered.
 * @param {object} s
 * @param {string} s.address      full winning PUBLIC base58 address
 * @param {number} s.revealed     how many leading chars are resolved (0..len)
 * @param {string} s.prefix
 * @param {number} s.iterations
 * @param {string} [s.agentName]
 * @returns {Promise<string>} PNG data URL
 */
export async function renderRevealFrame(s) {
	const addr = String(s.address || '');
	const revealed = Math.max(0, Math.min(addr.length, s.revealed ?? addr.length));
	const done = revealed >= addr.length;
	const iters = abbrev(s.iterations);

	// Build the address line: resolved chars in accent, the still-scrambling tail
	// from the base58 alphabet (deterministic per position, cosmetic only).
	const scrambleSrc = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
	let line = '';
	for (let i = 0; i < addr.length; i++) {
		if (i < revealed) {
			line += `<tspan fill="${ACCENT}">${esc(addr[i])}</tspan>`;
		} else {
			const c = scrambleSrc[Math.floor(jitter(s.iterations + i * 7) * scrambleSrc.length)] || '?';
			line += `<tspan fill="${DIM}">${esc(c)}</tspan>`;
		}
	}

	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
		`<rect width="${W}" height="${H}" fill="${BG}"/>` +
		`<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="${ACCENT}" stroke-width="3" opacity="${done ? 0.9 : 0.35}"/>` +
		`<text x="${W / 2}" y="220" text-anchor="middle" font-family="monospace" font-size="40" letter-spacing="8" fill="${ACCENT}">${done ? 'MATCH' : 'RESOLVING…'}</text>` +
		`<text x="${W / 2}" y="370" text-anchor="middle" font-family="monospace" font-size="34" fill="${TEXT}">${line}</text>` +
		`<text x="${W / 2}" y="470" text-anchor="middle" font-family="monospace" font-size="22" fill="${DIM}">found in ${iters} real attempts</text>` +
		(done
			? `<text x="${W / 2}" y="540" text-anchor="middle" font-family="monospace" font-size="20" fill="${ACCENT}">a real, usable branded wallet — secret delivered privately to the owner</text>`
			: '') +
		`<text x="${W / 2}" y="660" text-anchor="middle" font-family="monospace" font-size="16" fill="${DIM}">${esc(s.agentName || 'agent')} · vanity grinder</text>` +
		`</svg>`;

	return svgToDataUrl(svg);
}

// Loading / spin-up state shown before the first real sample arrives.
export async function renderSpinupFrame(s) {
	const prefix = esc(s.prefix || '');
	const suffix = s.suffix ? esc(s.suffix) : '';
	const pattern = suffix ? `${prefix}…${suffix}` : `${prefix}…`;
	const expected = abbrev(s.expectedIterations || 0);
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
		`<rect width="${W}" height="${H}" fill="${BG}"/>` +
		`<text x="${W / 2}" y="320" text-anchor="middle" font-family="monospace" font-size="34" fill="${TEXT}">Spinning up the grinder…</text>` +
		`<text x="${W / 2}" y="380" text-anchor="middle" font-family="monospace" font-size="26" fill="${ACCENT}">target ${pattern}</text>` +
		`<text x="${W / 2}" y="430" text-anchor="middle" font-family="monospace" font-size="20" fill="${DIM}">expected ~${expected} attempts</text>` +
		`</svg>`;
	return svgToDataUrl(svg);
}
