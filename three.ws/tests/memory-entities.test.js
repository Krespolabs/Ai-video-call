import { describe, it, expect } from 'vitest';
import { extractEntities, ENTITY_KINDS } from '../api/_lib/memory-entities.js';

describe('memory entity extraction', () => {
	it('extracts cashtags as uppercase tickers', () => {
		const ents = extractEntities('Bought more $three and $sol today');
		const tickers = ents.filter((e) => e.kind === 'ticker').map((e) => e.label);
		expect(tickers).toContain('THREE');
		expect(tickers).toContain('SOL');
	});

	it('extracts @handles as people', () => {
		const ents = extractEntities('chatting with @satoshi about the launch');
		expect(ents.find((e) => e.kind === 'person' && e.label === '@satoshi')).toBeTruthy();
	});

	it('classifies a base58 address as a mint when the memory is trade-flavored', () => {
		const mint = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
		const ents = extractEntities(`sniped the token ${mint}`, ['snipe']);
		expect(ents.find((e) => e.kind === 'mint' && e.label === mint)).toBeTruthy();
	});

	it('classifies a bare base58 address as a wallet without trade context', () => {
		// Clearly-synthetic base58 (matches the 32–44 char pattern, real to no one).
		const addr = 'WaLLeTsynthetic1111111111111111111111111111';
		const ents = extractEntities(`sent funds to ${addr}`);
		expect(ents.find((e) => e.kind === 'wallet' && e.label === addr)).toBeTruthy();
	});

	it('pulls structured context fields (mint, symbol, wallet)', () => {
		const ents = extractEntities('position update', ['trade'], {
			mint: 'THREEsynthetic1111111111111111111111111111',
			symbol: 'three',
			wallet: '0xabc0000000000000000000000000000000000def',
		});
		expect(ents.find((e) => e.kind === 'mint')).toBeTruthy();
		expect(ents.find((e) => e.kind === 'ticker' && e.label === 'THREE')).toBeTruthy();
		expect(ents.find((e) => e.kind === 'wallet')).toBeTruthy();
	});

	it('flags strategy memories', () => {
		const ents = extractEntities('Rule: always set a stop-loss at -20%', ['rule']);
		expect(ents.find((e) => e.kind === 'strategy')).toBeTruthy();
	});

	it('turns meaningful tags into topics but drops studio/chat/seed noise', () => {
		const ents = extractEntities('note', ['watchlist', 'studio', 'chat', 'seed']);
		const topics = ents.filter((e) => e.kind === 'topic').map((e) => e.label);
		expect(topics).toContain('watchlist');
		expect(topics).not.toContain('studio');
		expect(topics).not.toContain('chat');
	});

	it('deduplicates repeated entities and only emits known kinds', () => {
		const ents = extractEntities('$THREE $THREE $three');
		expect(ents.filter((e) => e.kind === 'ticker')).toHaveLength(1);
		for (const e of ents) expect(ENTITY_KINDS).toContain(e.kind);
	});

	it('extracts EVM addresses as wallets', () => {
		const ents = extractEntities('treasury 0x1234567890abcdef1234567890ABCDEF12345678');
		expect(ents.find((e) => e.kind === 'wallet')).toBeTruthy();
	});
});
