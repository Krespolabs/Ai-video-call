import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { PumpSdk, holderRewardsPda } from '@pump-fun/pump-sdk';

describe('Pump SDK 2.0 holder-reward launch', () => {
	it('builds the real create_v2 instruction offline with holder rewards enabled', async () => {
		const mint = Keypair.generate().publicKey;
		const creator = Keypair.generate().publicKey;
		const user = Keypair.generate().publicKey;
		const instruction = await new PumpSdk().createV2Instruction({
			mint,
			creator,
			user,
			name: 'Holder Demo',
			symbol: 'HOLD',
			uri: 'https://three.ws/metadata/holder-demo.json',
			mayhemMode: false,
			holderReward: true,
		});

		// OptionBool is encoded as a one-byte trailing value. This proves the
		// installed 2.0 builder produced the holder-reward variant without RPC,
		// signing, spending, or broadcasting a transaction.
		expect(instruction.data.at(-1)).toBe(1);
		expect(holderRewardsPda(mint).equals(creator)).toBe(false);
		expect(instruction.keys.some((key) => key.pubkey.equals(mint))).toBe(true);
		expect(instruction.keys.some((key) => key.pubkey.equals(user))).toBe(true);
	});
});
