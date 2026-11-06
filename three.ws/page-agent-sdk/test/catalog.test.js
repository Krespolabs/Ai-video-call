import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	AGENTS, DEFAULT_AGENT_ID, DEFAULT_ASSET_BASE,
	getAgent, agentUrl, filterAgents,
} from '../src/catalog.js';
import { estimateDurationMs, createLipsync } from '../src/lipsync.js';

test('catalog is non-empty and ids are unique', () => {
	assert.ok(AGENTS.length >= 8, 'expected a diverse roster');
	const ids = AGENTS.map((a) => a.id);
	assert.equal(new Set(ids).size, ids.length, 'agent ids must be unique');
});

test('every catalog agent is rigged and lipsync-classified', () => {
	const rigs = new Set(['rpm', 'mixamo', 'studio']);
	const lips = new Set(['viseme', 'jaw', 'animation']);
	for (const a of AGENTS) {
		assert.ok(rigs.has(a.rig), `${a.id} has a known rig`);
		assert.ok(lips.has(a.lipsync), `${a.id} declares a lipsync mode`);
		assert.ok(a.file.endsWith('.glb'), `${a.id} points at a GLB`);
		assert.ok(a.voice && (a.voice.lang || a.voice.match), `${a.id} has a voice profile`);
		assert.match(a.accent, /^#[0-9a-f]{6}$/i, `${a.id} has a hex accent`);
	}
});

test('roster is diverse across style and presentation', () => {
	assert.ok(new Set(AGENTS.map((a) => a.style)).size >= 3, 'multiple styles');
	assert.ok(new Set(AGENTS.map((a) => a.presents)).size >= 3, 'multiple presentations');
	assert.ok(AGENTS.some((a) => a.lipsync === 'viseme'), 'at least one viseme agent');
});

test('default agent exists', () => {
	assert.ok(getAgent(DEFAULT_AGENT_ID), 'default agent id resolves');
});

test('agentUrl resolves against the asset base and honors overrides', () => {
	const a = getAgent(DEFAULT_AGENT_ID);
	assert.equal(agentUrl(a), DEFAULT_ASSET_BASE + a.file);
	assert.equal(agentUrl(a, 'https://cdn.example/'), 'https://cdn.example/' + a.file);
	assert.equal(agentUrl({ ...a, url: 'https://x/y.glb' }), 'https://x/y.glb');
});

test('filterAgents narrows by id, style and lipsync', () => {
	assert.equal(filterAgents({ ids: [DEFAULT_AGENT_ID] }).length, 1);
	const viseme = filterAgents({ lipsync: 'viseme' });
	assert.ok(viseme.length && viseme.every((a) => a.lipsync === 'viseme'));
	assert.equal(filterAgents({ ids: ['does-not-exist'] }).length, 0);
});

test('lipsync duration grows with text length', () => {
	const short = estimateDurationMs('hi');
	const long = estimateDurationMs('the quick brown fox jumps over the lazy dog');
	assert.ok(long > short, 'longer text → longer timeline');
	assert.equal(estimateDurationMs(''), 0);
});

test('createLipsync with no morph map is a safe no-op', () => {
	const ls = createLipsync('hello there', null);
	assert.equal(ls.totalMs, 0);
	assert.doesNotThrow(() => { ls.tick(0); ls.tick(100); ls.stop(); });
});
