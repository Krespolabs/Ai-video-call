// Shared HTTP query-parameter parsing helpers for API handlers.
//
// Pagination clamps (`Math.min(Math.max(parseInt(...), 1), MAX)`) were copy-pasted
// across ~20 endpoints, each subtly mishandling non-numeric input (a `?limit=abc`
// produced `NaN`, which then silently disabled the clamp). These helpers
// centralise the logic and coerce junk input back to a sane default.

/**
 * Parse an integer from arbitrary input and clamp it into `[min, max]`.
 * Non-numeric / missing input falls back to `fallback` (which is itself clamped),
 * so callers never have to defend against `NaN` leaking downstream.
 *
 * @param {unknown} raw  Raw value (string from a query param, a body field, etc.)
 * @param {{ min?: number, max: number, fallback: number }} opts
 * @returns {number}
 */
export function clampInt(raw, { min = 1, max, fallback }) {
  if (!Number.isFinite(max)) throw new TypeError('clampInt: `max` is required and must be finite');
  if (!Number.isFinite(fallback)) throw new TypeError('clampInt: `fallback` is required and must be finite');
  const parsed = typeof raw === 'number' ? Math.trunc(raw) : parseInt(raw, 10);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(base, min), max);
}

/**
 * Read a value from a URLSearchParams-like or plain-object source.
 * @param {URLSearchParams | Record<string, unknown> | null | undefined} source
 * @param {string} key
 */
function readParam(source, key) {
  if (!source) return undefined;
  if (typeof source.get === 'function') return source.get(key);
  return source[key];
}

/**
 * Parse and clamp a `limit`-style pagination parameter.
 * @param {URLSearchParams | Record<string, unknown>} source
 * @param {{ fallback: number, max: number, min?: number, key?: string }} opts
 */
export function parseLimit(source, { fallback, max, min = 1, key = 'limit' }) {
  return clampInt(readParam(source, key), { min, max, fallback });
}

/**
 * Parse and clamp an `offset`-style pagination parameter (floors at 0 by default).
 * @param {URLSearchParams | Record<string, unknown>} source
 * @param {{ max?: number, min?: number, key?: string }} [opts]
 */
export function parseOffset(source, { max = Number.MAX_SAFE_INTEGER, min = 0, key = 'offset' } = {}) {
  return clampInt(readParam(source, key), { min, max, fallback: min });
}
