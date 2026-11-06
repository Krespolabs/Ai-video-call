import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';

import {
	SKILL_LICENSE_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
	skillSeed,
	deriveMarketplacePda,
	deriveSkillLicensePda,
	deriveSkillMintPda,
	deriveAssociatedTokenAddress,
	decodeSkillLicense,
	buildMintSkillLicenseIx,
	buildInitializeMarketplaceIx,
} from '../api/_lib/skill-license-onchain.js';

const idl = JSON.parse(
	readFileSync(fileURLToPath(new URL('../contracts/idl/skill_license.json', import.meta.url)), 'utf8'),
);

const OWNER = new PublicKey('9MjzHaTB6Jko4YKo9mDzJSaGnktzhbebgsnqPpYWnXC7');
const AGENT = new PublicKey('So11111111111111111111111111111111111111112');
const SKILL = 'summarize';

const ixDisc = (name) => idl.instructions.find((i) => i.name === name).discriminator;

describe('skillSeed', () => {
	it('is the 32-byte sha256 of the name, matching the Rust seed', () => {
		const seed = skillSeed(SKILL);
		expect(seed).toHaveLength(32);
		expect(Buffer.from(seed).toString('hex')).toBe(
			createHash('sha256').update(SKILL).digest('hex'),
		);
	});

	it('differs for different skill names', () => {
		expect(Buffer.from(skillSeed('a')).equals(Buffer.from(skillSeed('b')))).toBe(false);
	});
});

describe('PDA derivations', () => {
	it('marketplace PDA is deterministic and off-curve', () => {
		const [a, bumpA] = deriveMarketplacePda();
		const [b] = deriveMarketplacePda();
		expect(a.toBase58()).toBe(b.toBase58());
		expect(PublicKey.isOnCurve(a.toBytes())).toBe(false);
		expect(bumpA).toBeGreaterThanOrEqual(0);
		expect(bumpA).toBeLessThanOrEqual(255);
	});

	it('license + mint PDAs are deterministic for the same inputs', () => {
		const [lic1] = deriveSkillLicensePda(OWNER, AGENT, SKILL);
		const [lic2] = deriveSkillLicensePda(OWNER, AGENT, SKILL);
		const [mint1] = deriveSkillMintPda(OWNER, AGENT, SKILL);
		const [mint2] = deriveSkillMintPda(OWNER, AGENT, SKILL);
		expect(lic1.toBase58()).toBe(lic2.toBase58());
		expect(mint1.toBase58()).toBe(mint2.toBase58());
	});

	it('license and mint PDAs differ (distinct seed prefixes)', () => {
		const [lic] = deriveSkillLicensePda(OWNER, AGENT, SKILL);
		const [mint] = deriveSkillMintPda(OWNER, AGENT, SKILL);
		expect(lic.toBase58()).not.toBe(mint.toBase58());
	});

	it('changing skill, owner, or agent changes the license PDA', () => {
		const [base] = deriveSkillLicensePda(OWNER, AGENT, SKILL);
		const [otherSkill] = deriveSkillLicensePda(OWNER, AGENT, 'translate');
		const [otherOwner] = deriveSkillLicensePda(AGENT, AGENT, SKILL);
		const [otherAgent] = deriveSkillLicensePda(OWNER, OWNER, SKILL);
		const set = new Set([
			base.toBase58(),
			otherSkill.toBase58(),
			otherOwner.toBase58(),
			otherAgent.toBase58(),
		]);
		expect(set.size).toBe(4);
	});

	it('ATA derivation matches the standard associated-token program derivation', () => {
		const [mint] = deriveSkillMintPda(OWNER, AGENT, SKILL);
		const ata = deriveAssociatedTokenAddress(OWNER, mint);
		const [expected] = PublicKey.findProgramAddressSync(
			[OWNER.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
			ASSOCIATED_TOKEN_PROGRAM_ID,
		);
		expect(ata.toBase58()).toBe(expected.toBase58());
	});
});

describe('decodeSkillLicense', () => {
	function encodeLicense({ authority, agentMint, nftMint, skillName, purchaseDate, revokedAt, bump }) {
		const disc = Buffer.from(idl.accounts.find((a) => a.name === 'SkillLicense').discriminator);
		const pd = Buffer.alloc(8);
		pd.writeBigInt64LE(BigInt(purchaseDate));
		const rv = Buffer.alloc(8);
		rv.writeBigInt64LE(BigInt(revokedAt));
		const nameBytes = Buffer.from(skillName, 'utf8');
		const nameLen = Buffer.alloc(4);
		nameLen.writeUInt32LE(nameBytes.length);
		return Buffer.concat([
			disc,
			new PublicKey(authority).toBuffer(),
			new PublicKey(agentMint).toBuffer(),
			new PublicKey(nftMint).toBuffer(),
			Buffer.from(skillSeed(skillName)),
			pd,
			rv,
			Buffer.from([bump]),
			nameLen,
			nameBytes,
		]);
	}

	it('round-trips an active license', () => {
		const nft = Keypair.generate().publicKey;
		const buf = encodeLicense({
			authority: OWNER.toBase58(),
			agentMint: AGENT.toBase58(),
			nftMint: nft.toBase58(),
			skillName: SKILL,
			purchaseDate: 1_750_000_000,
			revokedAt: 0,
			bump: 254,
		});
		const rec = decodeSkillLicense(buf);
		expect(rec.authority).toBe(OWNER.toBase58());
		expect(rec.agentMint).toBe(AGENT.toBase58());
		expect(rec.nftMint).toBe(nft.toBase58());
		expect(rec.skillName).toBe(SKILL);
		expect(rec.purchaseDate).toBe(1_750_000_000);
		expect(rec.revokedAt).toBe(0);
		expect(rec.revoked).toBe(false);
		expect(rec.bump).toBe(254);
		expect(rec.skillHash).toBe(createHash('sha256').update(SKILL).digest('hex'));
	});

	it('reports a revoked license', () => {
		const buf = encodeLicense({
			authority: OWNER.toBase58(),
			agentMint: AGENT.toBase58(),
			nftMint: Keypair.generate().publicKey.toBase58(),
			skillName: SKILL,
			purchaseDate: 1_750_000_000,
			revokedAt: 1_750_500_000,
			bump: 255,
		});
		const rec = decodeSkillLicense(buf);
		expect(rec.revoked).toBe(true);
		expect(rec.revokedAt).toBe(1_750_500_000);
	});

	it('throws on a discriminator mismatch', () => {
		const bad = Buffer.alloc(200);
		expect(() => decodeSkillLicense(bad)).toThrow(/discriminator/);
	});
});

describe('buildMintSkillLicenseIx', () => {
	const minter = Keypair.generate().publicKey;
	const built = buildMintSkillLicenseIx({ minter, owner: OWNER, agentMint: AGENT, skillName: SKILL });
	const ix = built.instruction;

	it('targets the program and leads with the mint discriminator + borsh skill name', () => {
		expect(ix.programId.toBase58()).toBe(SKILL_LICENSE_PROGRAM_ID);
		expect([...ix.data.subarray(0, 8)]).toEqual(ixDisc('mint_skill_license'));
		// borsh string: u32 LE length then bytes
		expect(ix.data.readUInt32LE(8)).toBe(SKILL.length);
		expect(ix.data.subarray(12).toString('utf8')).toBe(SKILL);
	});

	it('orders accounts and signer/writable flags to match the IDL', () => {
		const [marketplace] = deriveMarketplacePda();
		const [license] = deriveSkillLicensePda(OWNER, AGENT, SKILL);
		const [nft] = deriveSkillMintPda(OWNER, AGENT, SKILL);
		const ata = deriveAssociatedTokenAddress(OWNER, nft);
		const expected = [
			[marketplace.toBase58(), false, true],
			[minter.toBase58(), true, true],
			[OWNER.toBase58(), false, false],
			[AGENT.toBase58(), false, false],
			[license.toBase58(), false, true],
			[nft.toBase58(), false, true],
			[ata.toBase58(), false, true],
			[TOKEN_PROGRAM_ID.toBase58(), false, false],
			[ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), false, false],
			[SystemProgram.programId.toBase58(), false, false],
			[SYSVAR_RENT_PUBKEY.toBase58(), false, false],
		];
		expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(expected);
	});

	it('reports the derived PDAs it used', () => {
		const [license] = deriveSkillLicensePda(OWNER, AGENT, SKILL);
		expect(built.accounts.skillLicense).toBe(license.toBase58());
	});
});

describe('buildInitializeMarketplaceIx', () => {
	it('encodes the discriminator + minter pubkey and the right account flags', () => {
		const authority = Keypair.generate().publicKey;
		const minter = Keypair.generate().publicKey;
		const { instruction: ix } = buildInitializeMarketplaceIx({ authority, minter });
		const [marketplace] = deriveMarketplacePda();

		expect([...ix.data.subarray(0, 8)]).toEqual(ixDisc('initialize_marketplace'));
		expect(new PublicKey(ix.data.subarray(8, 40)).toBase58()).toBe(minter.toBase58());
		expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
			[marketplace.toBase58(), false, true],
			[authority.toBase58(), true, true],
			[SystemProgram.programId.toBase58(), false, false],
		]);
	});
});

describe('IDL consistency', () => {
	it('declares the same program id baked into the lib', () => {
		expect(idl.address).toBe(SKILL_LICENSE_PROGRAM_ID);
	});

	it('exposes the five program instructions', () => {
		expect(idl.instructions.map((i) => i.name).sort()).toEqual(
			[
				'burn_skill_license',
				'initialize_marketplace',
				'mint_skill_license',
				'revoke_skill_license',
				'set_minter',
			].sort(),
		);
	});
});
