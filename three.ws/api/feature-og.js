// api/feature-og.js — Open Graph image for /features/<slug> landing pages.
// GET /api/feature-og?feature=forge&title=...&sub=...
//
// Returns a 1200×630 SVG card branded for the named feature.
// Self-contained SVG so all OG crawlers (Slack, X, Discord, iMessage) render it.

import { cors, wrap } from './_lib/http.js';

const CACHE = 'public, max-age=86400, s-maxage=604800';

const FEATURE_META = {
  forge: {
    label: 'Forge',
    route: '/forge',
    accent: '#a78bfa',
    icon: '⬡',
    tagline: 'Text → 3D Model',
  },
  scan: {
    label: 'Scan',
    route: '/scan',
    accent: '#6ee7ff',
    icon: '◎',
    tagline: 'Selfie → Rigged Avatar',
  },
  play: {
    label: 'Play',
    route: '/play',
    accent: '#4ade80',
    icon: '◈',
    tagline: 'Live 3D Coin Worlds',
  },
  walk: {
    label: 'Walk',
    route: '/temporary',
    accent: '#fb923c',
    icon: '◉',
    tagline: '3D Avatar + AR',
  },
  studio: {
    label: 'Studio',
    route: '/studio',
    accent: '#f472b6',
    icon: '◧',
    tagline: 'Widget Builder',
  },
  marketplace: {
    label: 'Marketplace',
    route: '/marketplace',
    accent: '#facc15',
    icon: '◰',
    tagline: 'Agent Marketplace',
  },
  'agent-exchange': {
    label: 'Agent Exchange',
    route: '/agent-exchange',
    accent: '#34d399',
    icon: '⟳',
    tagline: 'Agents Paying Each Other',
  },
  deploy: {
    label: 'Deploy',
    route: '/deploy',
    accent: '#60a5fa',
    icon: '◆',
    tagline: 'On-Chain Identity',
  },
};

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrap64(str, maxChars) {
  if (str.length <= maxChars) return [str, ''];
  const cut = str.lastIndexOf(' ', maxChars);
  if (cut <= 0) return [str.slice(0, maxChars), str.slice(maxChars).trim()];
  return [str.slice(0, cut), str.slice(cut + 1)];
}

export default wrap(async (req, res) => {
  if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

  const url = new URL(req.url, 'http://x');
  const slug = (url.searchParams.get('feature') || '').toLowerCase().replace(/[^a-z-]/g, '');
  const meta = FEATURE_META[slug] || {
    label: 'Features',
    route: '/features',
    accent: '#ffffff',
    icon: '◈',
    tagline: 'Explore the platform',
  };

  const titleParam = url.searchParams.get('title') || meta.label;
  const subParam = url.searchParams.get('sub') || meta.tagline;

  const [titleL1, titleL2] = wrap64(escapeXml(titleParam), 36);
  const [subL1, subL2] = wrap64(escapeXml(subParam), 58);

  const accent = escapeXml(meta.accent);
  const label = escapeXml(meta.label);
  const route = escapeXml(meta.route);
  const icon = escapeXml(meta.icon);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#050505"/>
      <stop offset="100%" stop-color="#0a0a0a"/>
    </linearGradient>
    <radialGradient id="glow" cx="75%" cy="20%" r="60%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="10%" cy="90%" r="40%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect width="1200" height="630" fill="url(#glow2)"/>

  <!-- Subtle grid -->
  <pattern id="grid" x="0" y="0" width="60" height="60" patternUnits="userSpaceOnUse">
    <path d="M 60 0 L 0 0 0 60" fill="none" stroke="rgba(255,255,255,0.025)" stroke-width="1"/>
  </pattern>
  <rect width="1200" height="630" fill="url(#grid)"/>

  <!-- Border -->
  <rect x="1" y="1" width="1198" height="628" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2" rx="0"/>

  <!-- Brand -->
  <text x="64" y="88" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="800" fill="rgba(255,255,255,0.9)" letter-spacing="-0.5">three.ws</text>
  <text x="64" y="88" dx="160" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="400" fill="rgba(255,255,255,0.3)" letter-spacing="-0.5">/ features</text>

  <!-- Feature pill -->
  <rect x="62" y="112" width="${label.length * 10 + 40 + 24}" height="34" rx="17" fill="${accent}" fill-opacity="0.12" stroke="${accent}" stroke-opacity="0.3" stroke-width="1"/>
  <text x="${38 + 24}" y="135" font-family="ui-monospace, monospace" font-size="13" font-weight="700" fill="${accent}" letter-spacing="1.5" text-anchor="middle"
    transform="translate(${label.length * 5 + 38}, 0)">${label.toUpperCase()}</text>
  <text x="78" y="135" font-family="ui-monospace, monospace" font-size="13" font-weight="700" fill="${accent}">${icon}</text>

  <!-- Main heading -->
  <text x="64" y="270" font-family="system-ui, -apple-system, sans-serif" font-size="72" font-weight="900" fill="#ffffff" letter-spacing="-2">${titleL1}</text>
  ${titleL2 ? `<text x="64" y="352" font-family="system-ui, -apple-system, sans-serif" font-size="72" font-weight="900" fill="#ffffff" letter-spacing="-2">${titleL2}</text>` : ''}

  <!-- Sub -->
  <text x="64" y="${titleL2 ? 400 : 316}" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="400" fill="rgba(255,255,255,0.55)" letter-spacing="-0.3">${subL1}</text>
  ${subL2 ? `<text x="64" y="${titleL2 ? 436 : 352}" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="400" fill="rgba(255,255,255,0.55)" letter-spacing="-0.3">${subL2}</text>` : ''}

  <!-- CTA pill -->
  <rect x="62" y="548" width="200" height="44" rx="22" fill="${accent}"/>
  <text x="162" y="576" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="800" fill="#000" text-anchor="middle" letter-spacing="0.2">Open ${label} →</text>

  <!-- Route label -->
  <text x="1136" y="576" font-family="ui-monospace, monospace" font-size="16" fill="rgba(255,255,255,0.25)" text-anchor="end" letter-spacing="0.5">three.ws${route}</text>
</svg>`;

  res.statusCode = 200;
  res.setHeader('content-type', 'image/svg+xml');
  res.setHeader('cache-control', CACHE);
  res.end(svg);
});
