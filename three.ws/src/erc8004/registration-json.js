/**
 * ERC-8004 registration JSON builder — pure, dependency-light.
 *
 * Split out of agent-registry.js (which pulls in ethers + a Three.js thumbnail
 * renderer for the browser deploy flow) so server-side callers — e.g. the MCP
 * `register_agent` tool that returns a prepared "continue in browser" payload —
 * can build the exact same document without dragging the wallet/renderer stack
 * into a serverless function. agent-registry.js re-exports this so the browser
 * import path is unchanged.
 */

import { agentRegistryId } from './abi.js';

/**
 * Build a spec-compliant ERC-8004 registration JSON.
 *
 * `imageUrl` is the 2D thumbnail (per NFT convention). `glbUrl` is optional —
 * when present, the GLB is surfaced as a dedicated `avatar` service entry and
 * a companion `3D` renderer service pointing at 3dagent so other apps can load
 * the body in-browser without coupling to our domain.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.description
 * @param {string} [opts.imageUrl]     2D thumbnail URL (PNG/JPG) — used for `image`
 * @param {string} [opts.glbUrl]       Optional GLB URL — emitted as an `avatar` service
 * @param {number} opts.agentId
 * @param {number} opts.chainId
 * @param {string} opts.registryAddr
 * @param {Array}  [opts.services]     Extra service entries
 * @param {boolean}[opts.x402Support]
 * @param {Array<{name:string,url:string,loop?:boolean,clipName?:string,source?:string}>} [opts.animations]
 *   Optional animation clip list — emitted as a top-level `animations` extension
 *   field (ERC-8004 permits extensions). Viewers that understand the field can
 *   attach extra clips; others ignore it harmlessly.
 * @param {string} [opts.manifest]
 *   Optional pointer (https:// or ipfs:// URI) to the rich agent-manifest bundle
 *   (specs/AGENT_MANIFEST.md) describing this agent's brain, voice, skills,
 *   memory, and permissions. Emitted as the 3D Agent Card v1 `manifest` field so
 *   on-chain agents carry their full Claude-shaped configuration, not just a body
 *   + thumbnail. Hosts that don't understand the field ignore it harmlessly.
 */
export function buildRegistrationJSON({
	name,
	description,
	imageUrl,
	glbUrl,
	agentId,
	chainId,
	registryAddr,
	services = [],
	x402Support = false,
	animations,
	manifest,
}) {
	const baseServices = [];
	if (glbUrl) {
		baseServices.push({
			name: 'avatar',
			endpoint: glbUrl,
			version: 'gltf-2.0',
		});
		baseServices.push({
			name: '3D',
			endpoint: `https://three.ws/app#model=${encodeURIComponent(glbUrl)}`,
			version: '1.0',
		});
	}

	const json = {
		type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
		name,
		description,
		image: imageUrl || '',
		active: true,
		x402Support,
		services: [...baseServices, ...services],
		registrations: [
			{
				agentId,
				agentRegistry: agentRegistryId(chainId, registryAddr),
			},
		],
		supportedTrust: ['reputation'],
	};

	// Top-level `body` field follows specs/AGENT_MANIFEST.md convention and is
	// read directly by src/manifest.js → normalize(). Spec-permitted (extension
	// fields MAY be added). Redundant with the `avatar` service entry above but
	// keeps this repo's manifest resolver happy without forcing it to grep services.
	if (glbUrl) {
		json.body = { uri: glbUrl, format: 'gltf-binary' };
	}

	if (Array.isArray(animations) && animations.length > 0) {
		json.animations = animations;
	}

	// Pointer to the rich agent-manifest/0.2 bundle (instructions, brain, voice,
	// skills, memory, permissions). Spec-permitted extension field read by
	// src/manifest.js → loadManifest(card.manifest) to hydrate the full agent.
	if (typeof manifest === 'string' && manifest) {
		json.manifest = manifest;
	}

	return json;
}
