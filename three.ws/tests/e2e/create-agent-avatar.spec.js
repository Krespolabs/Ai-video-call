/**
 * Create-agent wizard — avatar step smoke.
 *
 * Verifies the "every agent gets a 3D body" rules added to step 2:
 *   • the four model tabs render (Starter / My avatars / Upload / Add later)
 *   • the step blocks advancing until a real choice is made
 *   • the "My avatars" tab loads the caller's library and lets you connect one
 *   • the "Add later" path is gated behind an explicit acknowledgment, after
 *     which the agent will launch with the default body
 *
 * Auth + the avatars list are fulfilled from the Playwright route layer so the
 * client-side step logic can be exercised without a live session/DB. These are
 * test fixtures for the harness — the product code still calls the real
 * /api/auth/me and /api/avatars endpoints.
 */

import { test, expect } from '@playwright/test';

const FIXTURE_USER = {
	id: 'usr_e2e_creator',
	handle: 'e2e-creator',
	display_name: 'E2E Creator',
	plan: 'free',
};

// Synthetic avatars matching the real /api/avatars payload shape (model_url /
// base_model_url / thumbnail_url — there is no `url` field). The second avatar
// mimics a private one: no model_url, only a thumbnail. Both must still render
// and be selectable, since the agent links by id.
const FIXTURE_AVATARS = [
	{
		id: 'ava-e2e-one',
		name: 'Test Avatar One',
		model_url: '/avatars/default.glb',
		base_model_url: '/avatars/default.glb',
		thumbnail_url: '/favicon-32x32.png',
	},
	{
		id: 'ava-e2e-two',
		name: 'Test Avatar Two',
		model_url: null,
		base_model_url: null,
		thumbnail_url: '/favicon-32x32.png',
	},
];

async function installFixtures(page) {
	await page.route('**/api/auth/me**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ user: FIXTURE_USER }),
		}),
	);
	await page.route('**/api/avatars?**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ avatars: FIXTURE_AVATARS }),
		}),
	);
}

/** Advance from the Basics step into the 3D-model step with a valid name. */
async function gotoModelStep(page) {
	await page.goto('/create-agent');
	const name = page.locator('#f-name');
	await name.waitFor({ state: 'visible', timeout: 30_000 });
	await name.fill('E2E Test Agent');
	await page.locator('#btn-next').click();
	await expect(page.locator('.panel[data-step="1"].is-active')).toBeVisible();
}

test.describe('create-agent / avatar step', () => {
	test.beforeEach(async ({ page }) => {
		page.on('pageerror', (err) => {
			// Ignore Vite's dev-only HMR socket noise — not a product error.
			if (/WebSocket closed without opened/i.test(err.message)) return;
			throw new Error(`Uncaught page error: ${err.message}`);
		});
		await installFixtures(page);
	});

	test('renders all four model tabs', async ({ page }) => {
		test.setTimeout(90_000);
		await gotoModelStep(page);

		const tabs = page.locator('.model-tab');
		await expect(tabs).toHaveCount(4);
		await expect(page.locator('.model-tab[data-pane="starter"]')).toHaveText('Starter library');
		await expect(page.locator('.model-tab[data-pane="library"]')).toHaveText('My avatars');
		await expect(page.locator('.model-tab[data-pane="upload"]')).toHaveText('Upload your own');
		await expect(page.locator('.model-tab[data-pane="skip"]')).toHaveText('Add later');
	});

	test('blocks advancing with no avatar chosen', async ({ page }) => {
		test.setTimeout(90_000);
		await gotoModelStep(page);

		await page.locator('#btn-next').click();

		// Still on the model step, with an error prompting a choice.
		await expect(page.locator('.panel[data-step="1"].is-active')).toBeVisible();
		await expect(page.locator('#foot-msg.err')).toContainText('Pick a starter avatar');
	});

	test('connects an avatar from "My avatars" and advances', async ({ page }) => {
		test.setTimeout(90_000);
		await gotoModelStep(page);

		await page.locator('.model-tab[data-pane="library"]').click();

		// Tiles render from the (fixtured) library feed.
		const tiles = page.locator('#library-grid .starter');
		await expect(tiles).toHaveCount(FIXTURE_AVATARS.length);
		await expect(tiles.first()).toContainText('Test Avatar One');

		await tiles.first().click();
		await expect(tiles.first()).toHaveClass(/is-selected/);

		// A connected avatar satisfies the step — Next advances to Skills.
		await page.locator('#btn-next').click();
		await expect(page.locator('.panel[data-step="2"].is-active')).toBeVisible();
	});

	test('"Add later" requires acknowledgment, then uses the default body', async ({ page }) => {
		test.setTimeout(90_000);
		await gotoModelStep(page);

		await page.locator('.model-tab[data-pane="skip"]').click();

		// Without the acknowledgment, the step is blocked.
		await page.locator('#btn-next').click();
		await expect(page.locator('.panel[data-step="1"].is-active')).toBeVisible();
		await expect(page.locator('#foot-msg.err')).toContainText('default 3D body');

		// Acknowledge via the visible toggle (the native input is CSS-covered by
		// the track), then the step clears and advances.
		await page.locator('.model-pane[data-pane="skip"] label.toggle').click();
		await expect(page.locator('#f-skip-ack')).toBeChecked();
		await page.locator('#btn-next').click();
		await expect(page.locator('.panel[data-step="2"].is-active')).toBeVisible();
	});
});
