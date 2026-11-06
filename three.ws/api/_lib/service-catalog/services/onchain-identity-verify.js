// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'onchain-identity-verify',
	title: 'Identity Verify',
	category: 'trust',
	useCase: 'Cross-platform On-Chain Identity Verifier — prove any claim that an identity controls an address.',
	path: '/api/x402/onchain-identity-verify',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '5000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Identity Verify',
	tags: ['identity', 'verification', 'agent', 'trust', 'onchain'],
	description: 'Cross-platform On-Chain Identity Verifier — prove any claim that an identity controls an address. `identity` can be an ENS name, an SNS (.sol) name, an EVM or Solana wallet, an ERC-8004 agent id, or a three.ws agent_id; `address` is the contract/mint/wallet it claims. Returns on-chain evidence (deploy tx + deployer, mint/update authority, ENS/SNS resolution, ERC-8004 registration, three.ws deploy record) with verified true/false/unverifiable. Trust primitive before paying counterparty agents.',
	input: {
		identity: 'vitalik.eth',
		address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
		chain: 'eip155:1',
	},
	inputSchema: {
		type: 'object',
		required: ['identity', 'address'],
		properties: {
			identity: {
				type: 'string',
				description: 'ENS/SNS name, EVM/Solana wallet, ERC-8004 id (eip155:8453:42), or three.ws agent_id (uuid)',
			},
			address: {
				type: 'string',
				description: 'the contract/mint/wallet the identity claims to control',
			},
			chain: {
				type: 'string',
				description: 'optional CAIP-2 chain hint',
			},
		},
	},
	storefronts: ['x402scan'],
};
