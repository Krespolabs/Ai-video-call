import { describe, it, expect } from 'vitest';
import { buildRegistrationJSON } from '../../src/erc8004/registration-json.js';

const base = {
	name: 'TestBot',
	description: 'A 3D AI agent',
	imageUrl: 'https://three.ws/cdn/thumb.png',
	glbUrl: 'https://three.ws/cdn/body.glb',
	agentId: 42,
	chainId: 8453,
	registryAddr: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
};

describe('buildRegistrationJSON manifest field', () => {
	it('emits the manifest pointer when provided', () => {
		const json = buildRegistrationJSON({ ...base, manifest: 'ipfs://bafymanifest' });
		expect(json.manifest).toBe('ipfs://bafymanifest');
	});

	it('omits manifest when absent', () => {
		const json = buildRegistrationJSON(base);
		expect(json).not.toHaveProperty('manifest');
	});

	it('omits manifest for empty/non-string values', () => {
		expect(buildRegistrationJSON({ ...base, manifest: '' })).not.toHaveProperty('manifest');
		expect(buildRegistrationJSON({ ...base, manifest: null })).not.toHaveProperty('manifest');
		expect(buildRegistrationJSON({ ...base, manifest: 123 })).not.toHaveProperty('manifest');
	});

	it('keeps the rest of the spec-compliant card intact alongside manifest', () => {
		const json = buildRegistrationJSON({ ...base, manifest: 'https://three.ws/cdn/m.json' });
		expect(json.type).toBe('https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
		expect(json.name).toBe('TestBot');
		expect(json.registrations[0]).toEqual({
			agentId: 42,
			agentRegistry: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
		});
		// GLB still surfaces as the avatar service + top-level body.
		expect(json.body).toEqual({ uri: base.glbUrl, format: 'gltf-binary' });
		expect(json.services.some((s) => s.name === 'avatar' && s.endpoint === base.glbUrl)).toBe(true);
		expect(json.manifest).toBe('https://three.ws/cdn/m.json');
	});
});
