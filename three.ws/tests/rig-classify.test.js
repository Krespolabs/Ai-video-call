import { describe, it, expect } from 'vitest';
import { classifyRig, rigBadgeHTML } from '../src/shared/rig-classify.js';

describe('classifyRig', () => {
	it('classifies a model with the is_rigged flag as rigged', () => {
		const r = classifyRig({ source_meta: { is_rigged: true, skeleton_joint_count: 52 } });
		expect(r).toMatchObject({ category: 'rigged', rigged: true, known: true, jointCount: 52 });
	});

	it('classifies a positive joint count as rigged even without the flag', () => {
		const r = classifyRig({ source_meta: { skeleton_joint_count: 30 } });
		expect(r.category).toBe('rigged');
		expect(r.rigged).toBe(true);
	});

	it('classifies an inspected-but-skeleton-less model as static', () => {
		const r = classifyRig({ source_meta: { is_rigged: false, skeleton_joint_count: 0 } });
		expect(r).toMatchObject({ category: 'static', rigged: false, known: true, jointCount: 0 });
	});

	it('treats a never-inspected upload as unknown, not static', () => {
		const r = classifyRig({ source_meta: {} });
		expect(r).toMatchObject({ category: 'unknown', rigged: false, known: false });
	});

	it('treats a flag-false model with a stale positive joint count as rigged (joints win)', () => {
		const r = classifyRig({ source_meta: { is_rigged: false, skeleton_joint_count: 12 } });
		expect(r.category).toBe('rigged');
	});

	it('handles a missing source_meta / null avatar safely', () => {
		expect(classifyRig(null).category).toBe('unknown');
		expect(classifyRig({}).category).toBe('unknown');
	});
});

describe('rigBadgeHTML', () => {
	it('paints a rigged badge', () => {
		const html = rigBadgeHTML({ source_meta: { is_rigged: true } });
		expect(html).toContain('rig-badge--rigged');
		expect(html).toContain('Rigged');
	});

	it('paints a static badge', () => {
		const html = rigBadgeHTML({ source_meta: { is_rigged: false } });
		expect(html).toContain('rig-badge--static');
		expect(html).toContain('Static');
	});

	it('renders nothing for unknown so un-inspected uploads are not mislabeled', () => {
		expect(rigBadgeHTML({ source_meta: {} })).toBe('');
	});

	it('appends the joint count when asked', () => {
		const html = rigBadgeHTML({ source_meta: { is_rigged: true, skeleton_joint_count: 41 } }, { joints: true });
		expect(html).toContain('rig-badge-joints');
		expect(html).toContain('41');
	});
});
