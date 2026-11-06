#!/usr/bin/env node
// vertex-smoke.mjs — prove Claude on Vertex AI is enabled and callable.
//
// Sends a real streaming request to a Claude partner model on Vertex and
// prints the assistant's reply. A 200 with streamed content = the Model
// Garden enablement + quota + billing are all live for that model.
//
// This is the smoke test referenced by docs/gcp-credits.md. It is safe to run
// the moment the owner accepts the Anthropic partner-model terms in Model
// Garden — no code change needed. Until then it will 403/404 with a clear
// message pointing at the enablement step.
//
// Auth: reads GCP_SERVICE_ACCOUNT_JSON from the environment (same var Vercel
// uses), builds a JWT with Web Crypto, exchanges it for an OAuth access token,
// then calls streamRawPredict. Mirrors the token-exchange in
// api/_mcp3d/vertex-imagen.js so behavior is identical to production.
//
// Usage:
//   GCP_SERVICE_ACCOUNT_JSON="$(cat sa-key.json)" \
//   GOOGLE_CLOUD_PROJECT=aerial-vehicle-466722-p5 \
//   node scripts/gcp/vertex-smoke.mjs
//
// Optional env:
//   GOOGLE_CLOUD_LOCATION_CLAUDE   endpoint location (default: global)
//   VERTEX_SMOKE_MODEL             model id (default: claude-haiku-4-5@20251001)
//   VERTEX_SMOKE_PROMPT            prompt text (default: "ping")
//
// Exit codes: 0 = pass, 1 = misconfigured/auth, 2 = API rejected the call
// (usually enablement or quota — the message says which).

const PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.ANTHROPIC_VERTEX_PROJECT_ID ||
  '';
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION_CLAUDE || 'global';
const MODEL = process.env.VERTEX_SMOKE_MODEL || 'claude-haiku-4-5@20251001';
const PROMPT = process.env.VERTEX_SMOKE_PROMPT || 'ping';

function die(code, msg) {
  console.error(`\x1b[1;31m[vertex-smoke] FAIL\x1b[0m ${msg}`);
  process.exit(code);
}
function ok(msg) {
  console.log(`\x1b[1;32m[vertex-smoke] PASS\x1b[0m ${msg}`);
}
function info(msg) {
  console.log(`\x1b[1;36m[vertex-smoke]\x1b[0m ${msg}`);
}

// ── Service-account JSON parsing ────────────────────────────────────────────
// Secrets UIs mangle pasted JSON in predictable ways (extra quote wrapping,
// escaped inner quotes, raw control chars from a multi-line paste, base64).
// Accept every common mangling instead of crashing on JSON.parse. This is the
// same tolerance as api/_mcp3d/vertex-imagen.js.
function escapeJsonControlChars(s) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && ch === '\n') out += '\\n';
    else if (inString && ch === '\r') out += '\\r';
    else if (inString && ch === '\t') out += '\\t';
    else out += ch;
  }
  return out;
}

function parseServiceAccount(raw) {
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  const candidates = [v, v.replace(/\\"/g, '"')];
  candidates.push(escapeJsonControlChars(v), escapeJsonControlChars(v.replace(/\\"/g, '"')));
  if (/^[A-Za-z0-9+/=\s]+$/.test(v)) {
    try { candidates.push(Buffer.from(v, 'base64').toString('utf8')); } catch { /* not base64 */ }
  }
  for (const candidate of candidates) {
    try {
      const sa = JSON.parse(candidate);
      if (sa && typeof sa === 'object' && sa.client_email && sa.private_key) return sa;
    } catch { /* try next decoding */ }
  }
  return null;
}

// ── JWT → OAuth access token (Web Crypto, no external deps) ──────────────────
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  const keyData = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyBuffer = Buffer.from(keyData, 'base64');
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey, Buffer.from(signingInput),
  );
  const jwt = `${signingInput}.${Buffer.from(sigBuffer).toString('base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => String(res.status));
    die(1, `OAuth token exchange failed (${res.status}): ${err}`);
  }
  return (await res.json()).access_token;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!PROJECT) {
    die(1, 'GOOGLE_CLOUD_PROJECT (or ANTHROPIC_VERTEX_PROJECT_ID) is not set.');
  }
  const saRaw = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!saRaw || !saRaw.trim() || saRaw.trim() === '""') {
    die(1, 'GCP_SERVICE_ACCOUNT_JSON is not set. Export the Vercel inference SA key JSON.');
  }
  const sa = parseServiceAccount(saRaw);
  if (!sa) {
    die(1, 'GCP_SERVICE_ACCOUNT_JSON is not valid service-account JSON (need client_email + private_key).');
  }

  info(`project=${PROJECT} location=${LOCATION} model=${MODEL}`);
  info(`sa=${sa.client_email}`);
  const token = await getAccessToken(sa);
  info('OAuth token acquired — calling streamRawPredict…');

  // The `global` endpoint uses the aiplatform.googleapis.com host; regional
  // endpoints use {location}-aiplatform.googleapis.com.
  const host =
    LOCATION === 'global'
      ? 'aiplatform.googleapis.com'
      : `${LOCATION}-aiplatform.googleapis.com`;
  const url =
    `https://${host}/v1/projects/${PROJECT}/locations/${LOCATION}` +
    `/publishers/anthropic/models/${MODEL}:streamRawPredict`;

  const body = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: 64,
    messages: [{ role: 'user', content: PROMPT }],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let hint = '';
    if (res.status === 403 || res.status === 404) {
      hint =
        '\n  → Claude is likely not yet enabled in Model Garden for this project, or the SA lacks roles/aiplatform.user.' +
        '\n    Enable at: https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/' +
        MODEL.split('@')[0] +
        `?project=${PROJECT}`;
    } else if (res.status === 429) {
      hint = '\n  → Quota exceeded. Request a QPM/TPM increase for this model+region (see docs/gcp-credits.md).';
    }
    die(2, `streamRawPredict returned ${res.status}: ${errText}${hint}`);
  }

  // The response is a stream of JSON events (SSE-like). Accumulate any text
  // deltas so we can show the model actually produced tokens.
  const raw = await res.text();
  let text = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (jsonStr === '[DONE]') continue;
    try {
      const evt = JSON.parse(jsonStr);
      if (evt.type === 'content_block_delta' && evt.delta?.text) text += evt.delta.text;
      else if (evt.type === 'content_block_start' && evt.content_block?.text) text += evt.content_block.text;
    } catch { /* non-JSON keepalive line */ }
  }

  ok(`HTTP 200 — model replied: ${JSON.stringify(text.slice(0, 200)) || '(streamed, no text delta parsed)'}`);
  process.exit(0);
}

main().catch((e) => die(1, e?.stack || String(e)));
