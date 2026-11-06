// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('agent-team.js boot wiring', () => {
	beforeEach(() => {
		vi.resetModules();
		document.head.innerHTML = '';
		document.body.innerHTML = '';
	});

	it('injects the Team Task launcher into the live-wall hero', async () => {
		document.body.innerHTML = `<main><div class="al-hero"><h1>Watch agents work</h1></div><div id="al-grid"></div></main>`;
		await import('../src/agent-team.js');
		const btn = document.querySelector('.al-hero .tt-launch');
		expect(btn).toBeTruthy();
		expect(btn.textContent).toMatch(/Team Task/);
		expect(document.getElementById('tt-styles')).toBeTruthy();
	});

	it('adds a Team toggle to the agent-screen task bar', async () => {
		// agent-screen reads ?agentId from the URL.
		const url = new URL('http://localhost/agent-screen?agentId=abc-123');
		history.replaceState({}, '', url.pathname + url.search);
		document.body.innerHTML = `
			<form id="asc-task-form"><input id="asc-task-input" placeholder="task…"><button id="asc-task-send" type="submit">go</button></form>`;
		await import('../src/agent-team.js');
		const toggle = document.querySelector('.tt-toggle');
		expect(toggle).toBeTruthy();
		expect(toggle.getAttribute('aria-pressed')).toBe('false');
		toggle.click();
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
	});
});
