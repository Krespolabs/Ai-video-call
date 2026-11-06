/**
 * Forge — "Embed this model" panel. Playwright e2e.
 *
 * Roadmap prompt 10 (agent-native 3D + embeddable distribution): the Forge
 * result bar's Embed button opens a real panel with five distribution
 * flavours — iframe, web component, <agent-3d>, page-agent, and walk
 * companion. Drives the real /forge page + the real panel module
 * (src/forge-embed-panel.js / src/forge-embed-snippets.js); only the backend
 * generation call is fulfilled at the route layer (same pattern as
 * tests/e2e/forge-text-to-3d.spec.js) so the page's own real fetches, real DOM,
 * and real snippet builders are what's under test.
 */

import { test, expect } from '@playwright/test';

const RESULT_GLB = '/avatars/default.glb';

const CATALOG = {
	backends: [
		{
			id: 'nvidia',
			label: 'NVIDIA NIM',
			blurb: 'Free, fast text-to-3D',
			configured: true,
			free: true,
			byok: null,
			paths: ['image'],
			poly_control: false,
			user_images: true,
			estimates: { image: [{ tier: 'draft', eta_seconds: 18, credits: 0 }] },
		},
	],
	tiers: [{ id: 'draft', label: 'Draft', polycount: 50000 }],
	default_backend: { image: 'nvidia', geometry: 'nvidia' },
	default_backend_for_tier: { draft: { image: 'nvidia', geometry: 'nvidia' } },
};

const HEALTH = { backends: { nvidia: { status: 'up', message: '' } } };

const DONE = {
	job_id: null,
	status: 'done',
	glb_url: RESULT_GLB,
	creation_id: 'e2e-forge-embed-1',
	backend: 'nvidia',
	tier: 'draft',
	path: 'image',
};

async function installForge(page) {
	await page.route(
		(url) => url.pathname === '/api/forge',
		async (route) => {
			const req = route.request();
			const url = new URL(req.url());
			if (req.method() === 'GET' && url.searchParams.get('catalog')) return route.fulfill({ json: CATALOG });
			if (req.method() === 'GET' && url.searchParams.get('health')) return route.fulfill({ json: HEALTH });
			if (req.method() === 'POST') return route.fulfill({ json: DONE });
			return route.fulfill({ json: {} });
		},
	);
	await page.route((url) => url.pathname === '/api/forge-gallery', (r) => r.fulfill({ json: { enabled: false, creations: [] } }));
	for (const p of ['/api/forge-feedback', '/api/forge-categorize', '/api/forge-poster']) {
		await page.route((url) => url.pathname === p, (r) => r.fulfill({ json: { ok: true } }));
	}
}

async function generateAndOpenEmbed(page) {
	await installForge(page);
	await page.goto('/forge');
	const freeEngine = page.locator('#engine button', { has: page.locator('.eng-free') });
	await expect(freeEngine).toBeVisible({ timeout: 30_000 });
	await freeEngine.click();
	await page.locator('textarea#prompt').fill('a small ceramic mug');
	await page.locator('#generate').click();
	await expect(page.locator('#state-result')).toBeVisible({ timeout: 60_000 });

	const embedBtn = page.locator('#forge-embed-btn');
	await expect(embedBtn).toBeVisible();
	await embedBtn.click();
}

test.describe('Forge — embed this model panel', () => {
	test('opens with the iframe tab and a real /forge/embed snippet', async ({ page }) => {
		test.setTimeout(120_000);
		await generateAndOpenEmbed(page);

		const code = page.locator('#tws-emb-code');
		await expect(code).toBeVisible();
		await expect(code).toHaveValue(/<iframe/);
		await expect(code).toHaveValue(/\/forge\/embed\?src=/);
		// The live preview iframe actually points at the same viewer route.
		await expect(page.locator('.tws-emb-frame')).toHaveAttribute('src', /\/forge-embed\.html\?src=/);
	});

	test('page-agent tab renders the real AvatarStage/SpeechNarrator snippet', async ({ page }) => {
		test.setTimeout(120_000);
		await generateAndOpenEmbed(page);

		await page.locator('.tws-emb-tab[data-tab="page-agent"]').click();
		const code = page.locator('#tws-emb-code');
		await expect(code).toHaveValue(/@three-ws\/page-agent/);
		await expect(code).toHaveValue(/AvatarStage, SpeechNarrator/);
		await expect(code).toHaveValue(/stage\.load\(/);
		await expect(page.locator('.tws-emb-foot')).toContainText(/talking, lipsync guide/i);
	});

	test('walk companion tab renders the real createWalkCompanion snippet', async ({ page }) => {
		test.setTimeout(120_000);
		await generateAndOpenEmbed(page);

		await page.locator('.tws-emb-tab[data-tab="walk"]').click();
		const code = page.locator('#tws-emb-code');
		await expect(code).toHaveValue(/@three-ws\/walk/);
		await expect(code).toHaveValue(/createWalkCompanion/);
		await expect(code).toHaveValue(/source: 'static'/);
		await expect(code).toHaveValue(/rig: 'shared'/);
		await expect(page.locator('.tws-emb-foot')).toContainText(/corner companion/i);
	});

	test('agent-3d tab is still wired (regression: 5 tabs, none broken by the new two)', async ({ page }) => {
		test.setTimeout(120_000);
		await generateAndOpenEmbed(page);

		await page.locator('.tws-emb-tab[data-tab="agent3d"]').click();
		await expect(page.locator('#tws-emb-code')).toHaveValue(/<agent-3d/);

		await page.locator('.tws-emb-tab[data-tab="component"]').click();
		await expect(page.locator('#tws-emb-code')).toHaveValue(/<model-viewer/);

		// All five tabs are present and clickable.
		const tabs = page.locator('.tws-emb-tab');
		await expect(tabs).toHaveCount(5);
	});

	test('copy button copies the currently active tab\'s snippet', async ({ page, context }) => {
		test.setTimeout(120_000);
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await generateAndOpenEmbed(page);

		await page.locator('.tws-emb-tab[data-tab="walk"]').click();
		await page.locator('[data-emb-copy]').click();
		await expect(page.locator('.tws-emb-copy-label')).toHaveText(/Copied/, { timeout: 5000 });

		const clip = await page.evaluate(() => navigator.clipboard.readText());
		expect(clip).toContain('createWalkCompanion');
	});
});
