// Global nav holder chip. Loaded by the shared header (public/nav.js → the stable
// /nav-tier-badge.js bundle) right after the nav markup mounts, this hydrates the
// nav's #nav-tier-badge slot with the holder's $THREE tier ("◆ Silver") via the
// shared access helper. One mountTierBadge() call does it; the helper hides the chip
// for anonymous visitors and non-holders, shows it for a signed-in account OR a
// connected wallet, and links to /three#tiers.
//
// mountTierBadge re-hydrates itself on wallet:changed (it binds its own listener and
// keys the access cache by wallet), so a freshly-connected holder sees their tier —
// and a disconnect clears it — without a reload. No extra wiring needed here.

import { mountTierBadge } from './three-access.js';

const slot = document.getElementById('nav-tier-badge');
if (slot) mountTierBadge(slot);
