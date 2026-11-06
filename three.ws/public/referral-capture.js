/* three.ws — referral capture (zero-dep, static).
 *
 * Loaded on the public auth pages (/login, /register). Reads a `?ref=CODE`
 * query param, validates it against the referral-code alphabet, and parks it
 * in localStorage so the dashboard can attribute the referral once the user
 * has a session (see src/dashboard-next/referral-claim.js).
 *
 * Captured here rather than threaded through every auth handshake (email,
 * Privy, SIWS, SIWE) so a single replay covers all of them.
 */
(function () {
	var KEY = 'tw:ref';
	// Canonical referral-code shape: A–Z and 0–9, 3–20 chars. Vanity codes (the
	// member's name) may use any letter or digit; the auto-generator stays on a
	// restricted alphabet but matching must accept the full range. Mirrors
	// REFERRAL_CODE_RE in api/_lib/referrals.js.
	var CODE_RE = /^[A-Z0-9]{3,20}$/;
	// A captured code older than this is stale — drop it rather than attribute a
	// signup to a link the user clicked weeks ago.
	var MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

	function readParam() {
		try {
			var params = new URLSearchParams(window.location.search);
			var raw = params.get('ref') || params.get('r');
			if (!raw) return null;
			var code = raw.trim().toUpperCase();
			return CODE_RE.test(code) ? code : null;
		} catch {
			return null;
		}
	}

	// Fire a one-per-session visit beacon so the growth funnel can measure
	// share→visit→signup and the loop's k-factor. Best-effort and privacy-safe:
	// the server stores only a hash of (ip + ua + code), never raw identifiers.
	function beaconVisit(code) {
		try {
			var seenKey = 'tw:ref:visited';
			var seen = sessionStorage.getItem(seenKey);
			if (seen === code) return; // already counted this code this session
			sessionStorage.setItem(seenKey, code);
		} catch {
			// No sessionStorage (private mode) — still send once per page load.
		}
		var url = '/api/referral/visit';
		var payload = JSON.stringify({ code: code });
		try {
			if (navigator && typeof navigator.sendBeacon === 'function') {
				var blob = new Blob([payload], { type: 'application/json' });
				if (navigator.sendBeacon(url, blob)) return;
			}
		} catch {
			/* fall through to fetch */
		}
		try {
			fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: payload,
				keepalive: true,
			}).catch(function () {});
		} catch {
			/* visit tracking is best-effort */
		}
	}

	try {
		var code = readParam();
		if (code) {
			localStorage.setItem(KEY, JSON.stringify({ code: code, ts: Date.now() }));
			beaconVisit(code);
		} else {
			// Expire a stale capture so it never attributes a much later signup.
			var existing = localStorage.getItem(KEY);
			if (existing) {
				var parsed = JSON.parse(existing);
				if (!parsed || !parsed.ts || Date.now() - parsed.ts > MAX_AGE_MS) {
					localStorage.removeItem(KEY);
				}
			}
		}
	} catch {
		/* private mode / disabled storage — referral capture is best-effort */
	}
})();
