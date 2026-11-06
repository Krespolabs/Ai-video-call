/**
 * DeFi display formatting — ported verbatim from the SperaxOS `defi-utils`.
 * Output strings are intentionally stable: downstream snapshots depend on the
 * exact formatting, so do not "improve" these.
 */

/**
 * Format a USD value with a `$` currency symbol and 2 decimal places
 * (e.g. `1234.5` → `"$1,234.50"`).
 * @param {number} value
 * @returns {string}
 */
export function fmtUsd(value) {
	return value.toLocaleString('en-US', {
		currency: 'USD',
		maximumFractionDigits: 2,
		minimumFractionDigits: 2,
		style: 'currency',
	});
}

/**
 * Format a percentage value (e.g. `5.42` → `"5.42%"`).
 * @param {number} value
 * @returns {string}
 */
export function fmtPct(value) {
	return `${value.toFixed(2)}%`;
}

/**
 * Format a token amount with precision that scales to its magnitude: tiny
 * values collapse to `"<0.0001"`, sub-1 values get 6 decimals, sub-1000 get 4,
 * and larger values get grouped thousands with ≤2 decimals.
 * @param {number} value
 * @returns {string}
 */
export function fmtAmount(value) {
	if (value === 0) return '0';
	if (value < 0.0001) return '<0.0001';
	if (value < 1) return value.toFixed(6);
	if (value < 1000) return value.toFixed(4);
	return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
