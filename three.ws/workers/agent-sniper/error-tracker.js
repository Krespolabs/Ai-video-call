// agent-sniper — sliding-window error tracker.
//
// A few transient RPC errors are normal under the new-mint firehose; a *spike*
// means the RPC endpoint is degraded, an agent wallet is misconfigured, or the
// chain is congested — and snipes are silently failing. This tracks executor /
// RPC errors over a sliding window and trips ONCE when the count crosses the
// threshold, then re-arms only after the window drains, so a sustained problem
// pages once (sendOpsAlert also dedups) rather than on every failure.

export function makeErrorTracker({ threshold, windowMs }) {
	const hits = [];
	let last = null;
	let armed = true; // can fire again once below threshold

	function prune(now) {
		while (hits.length && now - hits[0] > windowMs) hits.shift();
	}

	return {
		/**
		 * Record an error. Returns a payload to alert on iff the spike threshold
		 * was just crossed (and not already alerted for this run-up), else null.
		 * @param {string} [message]
		 */
		record(message) {
			const now = Date.now();
			last = message || 'error';
			hits.push(now);
			prune(now);
			if (armed && hits.length >= threshold) {
				armed = false;
				return { count: hits.length, windowMs, lastError: last };
			}
			return null;
		},
		/** Re-arm once the window has drained below the threshold. */
		tick() {
			prune(Date.now());
			if (!armed && hits.length < threshold) armed = true;
		},
		get total() {
			return hits.length;
		},
		get lastError() {
			return last;
		},
	};
}
