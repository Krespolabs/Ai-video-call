/**
 * @three-ws/page-agent — public entry
 * ===================================
 *
 * A rigged 3D AI agent that talks visitors through any web page. Three ways in:
 *
 *  1. Zero-JS:  <script type="module" src=".../page-agent.global.js" data-page-agent
 *                       data-avatar="nova" data-auto-narrate></script>
 *  2. HTML tag: import '@three-ws/page-agent';  then  <page-agent auto-narrate></page-agent>
 *  3. Imperative:
 *        import { PageAgent } from '@three-ws/page-agent';
 *        const guide = new PageAgent({ agent: 'sol', autoNarrate: true });
 *        guide.narrate('Welcome — let me show you around.');
 *
 * Every agent in the catalog is skeleton-rigged and lipsync-capable; unrigged
 * meshes are intentionally excluded.
 */

import { PageAgent } from './page-agent.js';
import { registerElement } from './element.js';

export { PageAgent, collectSegments } from './page-agent.js';
export { PageAgentElement, registerElement } from './element.js';
export { AvatarStage } from './stage.js';
export { SpeechNarrator } from './narrator.js';
export { AvatarPicker } from './picker.js';
export { createLipsync, buildMorphMap, estimateDurationMs } from './lipsync.js';
export {
	AGENTS, DEFAULT_AGENT_ID, DEFAULT_ASSET_BASE,
	getAgent, agentUrl, filterAgents,
} from './catalog.js';
export {
	PRESETS, PRESET_IDS, resolvePreset, sanitizeContext, buildSystemPrompt,
} from './presets.js';

// Register the <page-agent> element on import (browser only).
if (typeof window !== 'undefined') {
	registerElement();
}

/**
 * Convenience factory — mount a page agent and return the controller.
 * @param {ConstructorParameters<typeof PageAgent>[0]} [config]
 * @returns {PageAgent}
 */
export function mount(config) {
	return new PageAgent(config);
}

/**
 * Auto-init from a `<script data-page-agent>` tag. Lets a site drop the agent
 * in with no JS at all — the script's `data-*` attributes become the config.
 * Idempotent: only the first tagged script mounts an instance.
 */
function autoInit() {
	if (typeof document === 'undefined' || window.__threeWsPageAgent) return;
	const tag = document.currentScript
		|| document.querySelector('script[data-page-agent]');
	if (!tag || !tag.hasAttribute('data-page-agent')) return;

	const d = tag.dataset;
	const autoNarrate = 'autoNarrate' in d ? (d.autoNarrate || true) : false;
	let context;
	if (d.context) {
		try {
			const parsed = JSON.parse(d.context);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) context = parsed;
		} catch { /* malformed JSON — ignored, context stays undefined */ }
	}
	window.__threeWsPageAgent = new PageAgent({
		agent: d.avatar || undefined,
		agents: d.agents?.split(',').map((s) => s.trim()).filter(Boolean),
		position: d.position || undefined,
		assetBase: d.assetBase || undefined,
		greeting: d.greeting || undefined,
		autoNarrate,
		muted: 'muted' in d,
		collapsed: 'collapsed' in d,
		picker: !('noPicker' in d),
		controls: !('noControls' in d),
		preset: d.preset || undefined,
		context,
	});
}

if (typeof window !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', autoInit, { once: true });
	} else {
		autoInit();
	}
}

export default PageAgent;
