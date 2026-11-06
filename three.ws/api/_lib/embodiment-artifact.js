// Embodiment artifact — the inline "living body" an MCP tool hands back.
//
// A persona tool (create / reload / speak) returns one of these: a self-contained
// text/html resource that mounts the hosted embodiment embed
// (pages/embodiment/embed.html → apps-sdk/embodiment/EmbodimentStage) in a
// sandboxed iframe and passes this turn's speak/emotion payload as query params.
// The Apps SDK host (ChatGPT/Claude) renders it inline: the rigged body idles
// between turns, lip-syncs the reply, and shows the matching expression + gesture.
//
// Shared by the paid studio (api/_mcp3d) and the free studio (api/_mcp-studio) so
// both drive the SAME body from the SAME hosted page — one embodiment surface, two
// front doors. Nothing here references a token, wallet, coin, or payment: a
// persona is a name and a 3D body.

import { env } from './env.js';

// The hosted embed page. Absolute + env-derived so the URL is framable from any
// host (ChatGPT, Claude), not tied to the request origin of the MCP call.
export const EMBODIMENT_EMBED_URL = `${env.APP_ORIGIN}/embodiment/embed`;

const escapeHtml = (s) =>
	String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Build the embed URL for a persona in a given conversational state. `glb` is
 * always passed inline so the body loads without a round-trip; `persona` is passed
 * too so a bare-id reload (no glb) still resolves via /api/mcp3d/persona.
 *
 * @param {{ persona: object, state?: string, text?: string, emotion?: string, intensity?: number, gesture?: string|null, wallet?: boolean, network?: string }} args
 * @returns {string}
 */
export function buildEmbedUrl({ persona, state, text, emotion, intensity, gesture, wallet, network }) {
	const u = new URL(EMBODIMENT_EMBED_URL);
	u.searchParams.set('persona', persona.persona_id);
	if (persona.glb_url) u.searchParams.set('glb', persona.glb_url);
	if (persona.name) u.searchParams.set('name', persona.name);
	if (state) u.searchParams.set('state', state);
	if (text) u.searchParams.set('text', String(text).slice(0, 600));
	if (emotion) u.searchParams.set('emotion', emotion);
	if (intensity != null) u.searchParams.set('intensity', String(intensity));
	if (gesture) u.searchParams.set('gesture', gesture);
	// Opt-in live chain-state visuals (prompt 17 — persona_identity/persona-wallet).
	// Omitted entirely for plain embodiment so the free/no-wallet path never
	// gains a network call it didn't ask for.
	if (wallet) {
		u.searchParams.set('wallet', '1');
		if (network) u.searchParams.set('network', network);
	}
	return u.toString();
}

/**
 * Render the embodied persona as an inline MCP resource: a self-contained HTML
 * document that frames the hosted embed and carries the turn's payload. The
 * `openai/outputTemplate` _meta lets Apps SDK hosts that key off a registered
 * template reuse the same embed URL.
 *
 * @param {{ persona: object, state?: string, text?: string, emotion?: string, intensity?: number, gesture?: string|null, wallet?: boolean, network?: string }} args
 * @returns {{ type: 'resource', resource: object }}
 */
export function embodimentArtifact({ persona, state = 'idle', text = '', emotion = 'neutral', intensity = 0, gesture = null, wallet = false, network }) {
	const embedUrl = buildEmbedUrl({ persona, state, text, emotion, intensity, gesture, wallet, network });
	const name = persona.name || 'Agent';
	const html =
		`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>${escapeHtml(name)} — live</title>` +
		`<style>html,body{margin:0;height:100%;background:transparent}` +
		`.wrap{position:relative;width:100%;height:480px;border-radius:16px;overflow:hidden;` +
		`background:radial-gradient(120% 120% at 50% 0%,#1a1a24 0%,#0c0c12 70%)}` +
		`iframe{width:100%;height:100%;border:0;display:block}` +
		`.fb{position:absolute;inset:auto 0 0 0;padding:8px 12px;font:600 12px system-ui;color:#cbd5e1;text-align:center}` +
		`.fb a{color:#a78bfa}</style></head><body>` +
		`<div class="wrap"><iframe title="${escapeHtml(name)} live avatar" ` +
		`src="${escapeHtml(embedUrl)}" allow="autoplay" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>` +
		`<noscript class="fb">Open <a href="${escapeHtml(embedUrl)}">${escapeHtml(name)}</a> in a browser.</noscript>` +
		`</div></body></html>`;
	return {
		type: 'resource',
		resource: {
			uri: embedUrl,
			mimeType: 'text/html',
			text: html,
			_meta: { 'openai/outputTemplate': embedUrl },
		},
	};
}
