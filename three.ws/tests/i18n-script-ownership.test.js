// @vitest-environment jsdom
//
// A page script often shows a placeholder in an annotated element and later
// writes live data into that same element: "Checking…" becomes "3 agents
// online", "Play" becomes "Pause". The catalog pass lands after an async
// /api/locale fetch, so without a guard it arrives after that write and puts the
// translated placeholder back over the live value. /pay's balance pill and
// /pump-visualizer's counters both shipped that bug.
//
// The runtime now infers ownership: it remembers what an element held when it
// first saw it and what it last wrote there, and leaves anything else alone.
// These tests pin that contract without any data-i18n-owned opt-in.

import { describe, it, expect, beforeEach } from 'vitest';
import { applyCatalog, primeOwnership } from '../src/i18n.js';

const catalog = (map) => (key) => (key in map ? map[key] : key);

describe('the catalog pass never overwrites a value the page wrote', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('leaves a live value written after first sight in place', () => {
		document.body.innerHTML = '<span id="s" data-i18n="p.status">Checking…</span>';
		primeOwnership(document);
		document.getElementById('s').textContent = '3 agents online';
		applyCatalog(document, catalog({ 'p.status': 'Comprobando…' }));
		expect(document.getElementById('s').textContent).toBe('3 agents online');
	});

	it('still translates an element the page never touched', () => {
		document.body.innerHTML = '<h1 id="h" data-i18n="p.title">Airdrop Checker</h1>';
		primeOwnership(document);
		applyCatalog(document, catalog({ 'p.title': 'Verificador de airdrops' }));
		expect(document.getElementById('h').textContent).toBe('Verificador de airdrops');
	});

	it('re-translates its own earlier write on a locale switch', () => {
		document.body.innerHTML = '<button id="b" data-i18n="p.go">Check eligibility</button>';
		primeOwnership(document);
		applyCatalog(document, catalog({ 'p.go': 'Verificar elegibilidad' }));
		applyCatalog(document, catalog({ 'p.go': 'Berechtigung prüfen' }));
		expect(document.getElementById('b').textContent).toBe('Berechtigung prüfen');
	});

	it('translates again once the page puts the source text back', () => {
		document.body.innerHTML = '<button id="b" data-i18n="p.play">Play</button>';
		primeOwnership(document);
		const b = document.getElementById('b');
		b.textContent = 'Pause';
		applyCatalog(document, catalog({ 'p.play': 'Reproducir' }));
		expect(b.textContent).toBe('Pause');
		b.textContent = 'Play';
		applyCatalog(document, catalog({ 'p.play': 'Reproducir' }));
		expect(b.textContent).toBe('Reproducir');
	});

	it('keeps a live child of a data-i18n-html block attached', () => {
		document.body.innerHTML = '<p data-i18n-html="p.stat"><b id="n">0</b> tokens</p>';
		primeOwnership(document);
		const live = document.getElementById('n');
		live.textContent = '72';
		applyCatalog(document, catalog({ 'p.stat': '<b id="n">0</b> Token' }));
		expect(live.isConnected).toBe(true);
		expect(live.textContent).toBe('72');
	});

	it('translates on first sight when the runtime was never primed', () => {
		document.body.innerHTML = '<p id="x" data-i18n="p.x">Hello</p>';
		applyCatalog(document, catalog({ 'p.x': 'Hola' }));
		expect(document.getElementById('x').textContent).toBe('Hola');
	});
});
