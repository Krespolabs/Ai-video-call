// Local demo bridge: exposes the authenticated MetaMask Agentic CLI (`mm`)
// server wallet to the demo page over HTTP. Runs on localhost only — the CLI
// session lives on this machine, so this server must never be exposed publicly.
//
// Usage:  node examples/metamask-agent-wallet/server.mjs
// Then open http://localhost:4280

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyMessage } from 'viem';

const PORT = Number(process.env.PORT || 4280);
const HOST = '127.0.0.1';
const ROOT = dirname(fileURLToPath(import.meta.url));
const CHAIN_ID = 8453; // Base
const MAX_MESSAGE_LENGTH = 500;

function mm(args) {
  return new Promise((resolve, reject) => {
    execFile('mm', [...args, '--json'], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed.ok) return reject(new Error(JSON.stringify(parsed)));
        resolve(parsed.data);
      } catch {
        reject(new Error(`Unparseable mm output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

async function getWallet() {
  const [auth, address, balance] = await Promise.all([
    mm(['auth', 'status']),
    mm(['wallet', 'address']),
    mm(['wallet', 'balance']),
  ]);
  return {
    authenticated: auth.authenticated,
    mode: address.mode,
    chainNamespace: address.chainNamespace,
    address: address.address,
    chainId: CHAIN_ID,
    network: 'Base',
    totalValueUsd: balance.totalValue,
    chains: balance.chains,
  };
}

async function signAndVerify(message) {
  const signed = await mm([
    'wallet', 'sign-message',
    '--message', message,
    '--chain-id', String(CHAIN_ID),
    '--wait',
  ]);
  const valid = await verifyMessage({
    address: signed.address,
    message,
    signature: signed.signature,
  });
  return {
    address: signed.address,
    status: signed.status,
    signature: signed.signature,
    standard: 'EIP-191 (personal_sign)',
    verified: valid,
  };
}

async function getEthPrice() {
  const data = await mm(['price', 'spot', '--asset-ids', `eip155:${CHAIN_ID}/slip44:60`, '--vs', 'usd']);
  return { symbol: 'ETH', network: 'Base', usd: data.prices[0]?.price ?? null };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/agent-wallet') {
      return sendJson(res, 200, await getWallet());
    }
    if (req.method === 'GET' && url.pathname === '/api/price') {
      return sendJson(res, 200, await getEthPrice());
    }
    if (req.method === 'POST' && url.pathname === '/api/agent-wallet/sign') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) return sendJson(res, 400, { error: 'message is required' });
      if (message.length > MAX_MESSAGE_LENGTH) {
        return sendJson(res, 400, { error: `message must be ≤ ${MAX_MESSAGE_LENGTH} characters` });
      }
      return sendJson(res, 200, await signAndVerify(message));
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MetaMask agent wallet demo → http://localhost:${PORT}`);
});
