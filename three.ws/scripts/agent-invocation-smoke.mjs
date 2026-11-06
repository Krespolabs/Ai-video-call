#!/usr/bin/env node
/**
 * Devnet smoke test for the deployed `agent_invocation` Solana program.
 *
 * Exercises the published SDK end-to-end against the LIVE program:
 *   1. confirms the program id is deployed + executable on the target cluster,
 *   2. mints two synthetic agent authorities (never a real third-party wallet),
 *   3. funds the invoker (devnet airdrop, or a funder key on other clusters),
 *   4. calls `invokeSkill()` from @three-ws/agent-protocol-sdk,
 *   5. decodes the on-chain `SkillInvoked` event and asserts every field.
 *
 * Re-runnable: it generates fresh authorities each run, so it never collides
 * with a previous invocation. Exits non-zero on any failure.
 *
 * Env:
 *   SOLANA_RPC_URL_DEVNET  RPC endpoint (default https://api.devnet.solana.com)
 *   AGENT_INVOCATION_PROGRAM_ID  override the program id (defaults to SDK value)
 *   SMOKE_FUNDER_KEYPAIR   path to a funded payer keypair (required off devnet,
 *                          where the faucet airdrop is unavailable)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const { invokeSkill, deriveAgentPda, AGENT_INVOCATION_PROGRAM_ID, IDL } = require(
  '../agent-protocol-sdk/dist/index.js',
);

const RPC = process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(
  process.env.AGENT_INVOCATION_PROGRAM_ID || AGENT_INVOCATION_PROGRAM_ID,
);
const SKILL = 'summarize';
const PARAMS = JSON.stringify({ url: 'https://three.ws', lang: 'en' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadKeypair(path) {
  const bytes = Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8')));
  return Keypair.fromSecretKey(bytes);
}

async function fundInvoker(connection, invoker) {
  if (process.env.SMOKE_FUNDER_KEYPAIR) {
    const funder = loadKeypair(process.env.SMOKE_FUNDER_KEYPAIR);
    const { SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: invoker.publicKey,
        lamports: 0.02 * LAMPORTS_PER_SOL,
      }),
    );
    await sendAndConfirmTransaction(connection, tx, [funder], { commitment: 'confirmed' });
    return;
  }
  // Devnet faucet — retried, it is frequently rate-limited.
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const sig = await connection.requestAirdrop(invoker.publicKey, 0.05 * LAMPORTS_PER_SOL);
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`  airdrop attempt ${attempt} failed: ${err.message}; retrying…`);
      await sleep(2000 * attempt);
    }
  }
  throw new Error(
    `could not fund invoker via devnet faucet after retries (${lastErr?.message}). ` +
      'Set SMOKE_FUNDER_KEYPAIR to a funded payer and re-run.',
  );
}

function field(data, snake, camel) {
  return data[snake] ?? data[camel];
}

async function main() {
  console.log(`agent_invocation smoke test`);
  console.log(`  rpc:     ${RPC}`);
  console.log(`  program: ${PROGRAM_ID.toBase58()}`);

  const connection = new Connection(RPC, 'confirmed');

  const programAccount = await connection.getAccountInfo(PROGRAM_ID);
  if (!programAccount || !programAccount.executable) {
    throw new Error(
      `program ${PROGRAM_ID.toBase58()} is not deployed/executable on ${RPC}. Deploy it first.`,
    );
  }
  console.log(`  program is deployed + executable ✓`);

  const invokerAuthority = Keypair.generate();
  const targetAuthority = Keypair.generate();
  console.log(`  invoker authority: ${invokerAuthority.publicKey.toBase58()}`);
  console.log(`  target  authority: ${targetAuthority.publicKey.toBase58()}`);

  console.log(`  funding invoker…`);
  await fundInvoker(connection, invokerAuthority);

  const [invokerAgent] = deriveAgentPda(invokerAuthority.publicKey, PROGRAM_ID);
  const [targetAgent] = deriveAgentPda(targetAuthority.publicKey, PROGRAM_ID);

  console.log(`  submitting invoke_skill('${SKILL}')…`);
  const signature = await invokeSkill({
    connection,
    invokerAuthority,
    targetAuthority: targetAuthority.publicKey,
    skillName: SKILL,
    parameters: PARAMS,
    programId: PROGRAM_ID,
  });
  console.log(`  tx confirmed: ${signature}`);

  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta?.logMessages) throw new Error('confirmed tx has no log messages to parse');

  const idl = { ...IDL, address: PROGRAM_ID.toBase58() };
  const parser = new anchor.EventParser(PROGRAM_ID, new anchor.BorshCoder(idl));
  const events = [...parser.parseLogs(tx.meta.logMessages)];
  const event = events.find((e) => e.name === 'SkillInvoked' || e.name === 'skillInvoked');
  if (!event) throw new Error(`no SkillInvoked event found in tx logs (${events.map((e) => e.name)})`);

  const d = event.data;
  const checks = [
    ['invoker_agent', field(d, 'invoker_agent', 'invokerAgent').toBase58(), invokerAgent.toBase58()],
    ['target_agent', field(d, 'target_agent', 'targetAgent').toBase58(), targetAgent.toBase58()],
    [
      'invoker_authority',
      field(d, 'invoker_authority', 'invokerAuthority').toBase58(),
      invokerAuthority.publicKey.toBase58(),
    ],
    ['skill_name', field(d, 'skill_name', 'skillName'), SKILL],
    ['parameters', d.parameters, PARAMS],
  ];
  for (const [name, got, want] of checks) {
    if (got !== want) throw new Error(`event.${name} mismatch: got ${got}, expected ${want}`);
    console.log(`  event.${name} ✓`);
  }
  const ts = Number(field(d, 'timestamp', 'timestamp'));
  if (!Number.isFinite(ts) || ts <= 0) throw new Error(`event.timestamp invalid: ${ts}`);
  console.log(`  event.timestamp ✓ (${new Date(ts * 1000).toISOString()})`);

  const cluster = RPC.includes('devnet') ? '?cluster=devnet' : '';
  console.log(`\n✅ SkillInvoked verified on-chain.`);
  console.log(`   https://explorer.solana.com/tx/${signature}${cluster}`);
}

main().catch((err) => {
  console.error(`\n❌ smoke test failed: ${err.message}`);
  process.exit(1);
});
