import { test, expect } from '@playwright/test';

// Regression guard for the invisible-overlay class of bug.
//
// The Brain Studio modal (#bsModal) is a full-screen `position:fixed; inset:0;
// z-index:1000` layer meant to stay hidden (via the `hidden` attribute) until you
// open Templates or the behaviour view. A CSS rule that set `display:grid` on the
// base class once defeated `hidden`, so the empty overlay rendered on top of the
// whole Brain tab and swallowed every click — /agent-studio#brain looked dead.
//
// This drives a real Chromium against the studio with auth + agent stubbed at the
// network seam (the same technique as nav-auth.spec.js) so the Brain panel
// actually mounts, then proves: at rest nothing covers the canvas, the overlay is
// genuinely hidden, and the open→close lifecycle still works. Any future rule that
// lets a hidden overlay paint will fail here regardless of its root cause.

const USER = { id: 'studio-test-user', handle: 'tester', wallet: 'THREEsynthetic1111111111111111111111111111' };
const AGENT = {
	id: 'studio-test-agent',
	name: 'Overlay Probe',
	description: 'Brain Studio overlay regression probe',
	avatarId: null,
	skills: [],
	meta: {},
	isOwner: true,
	isRegistered: false,
	walletAddress: null,
	chainId: null,
};

function stubStudioApis(page) {
	const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
	return Promise.all([
		page.route('**/api/auth/me', (route) => route.fulfill(json({ user: USER }))),
		page.route('**/api/agents/me', (route) => route.fulfill(json({ agent: AGENT }))),
	]);
}

/** True when the viewport centre is interactive (no element
 *  with the given selector sits on top, intercepting clicks). */
async function centreIsClickThrough(page, selector) {
	return page.evaluate((sel) => {
		const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
		return !(el && el.closest(sel));
	}, selector);
}

test.describe('Agent Studio · Brain tab overlay', () => {
	test('the modal overlay never covers the page at rest', async ({ page }) => {
		await stubStudioApis(page);
		await page.goto('/agent-studio#brain', { waitUntil: 'domcontentloaded' });

		// Brain panel mounts once the shell loads the (stubbed) agent.
		const brain = page.locator('.brainstudio');
		await expect(brain).toBeVisible({ timeout: 60_000 });

		// Enter the editor view so #bsModal exists in the DOM (onboarding renders
		// a "Blank brain" CTA; an already-configured agent renders the editor).
		const blank = page.locator('#bsBlank');
		if (await blank.count()) await blank.click();

		const modal = page.locator('#bsModal');
		await expect(modal).toBeHidden();
		// The empty overlay must not be the element under the viewport centre.
		expect(await centreIsClickThrough(page, '#bsModal')).toBe(true);
	});

	test('opening a modal shows it and closing returns the page to click-through', async ({ page }) => {
		await stubStudioApis(page);
		await page.goto('/agent-studio#brain', { waitUntil: 'domcontentloaded' });
		await expect(page.locator('.brainstudio')).toBeVisible({ timeout: 60_000 });

		const blank = page.locator('#bsBlank');
		if (await blank.count()) await blank.click();

		// Templates opens the shared modal. Fire the real toolbar handler directly:
		// the editor's graph canvas captures pointer events across its hit-area, so a
		// synthetic Playwright click on the toolbar button races the canvas. We're
		// asserting the modal's visibility CSS, not the button's reachability.
		await expect(page.locator('#bsTpl')).toBeVisible();
		await page.evaluate(() => document.querySelector('#bsTpl').click());
		const modal = page.locator('#bsModal');
		await expect(modal).toBeVisible();
		expect(await centreIsClickThrough(page, '#bsModal')).toBe(false); // it covers, by design

		// …and the close (×) hides it again, restoring interaction. The × sits on the
		// modal (z-index:1000), above the canvas, so a real click is safe here.
		await page.locator('#bsModalCard .brainstudio__modal-x').click();
		await expect(modal).toBeHidden();
		expect(await centreIsClickThrough(page, '#bsModal')).toBe(true);
	});
});
