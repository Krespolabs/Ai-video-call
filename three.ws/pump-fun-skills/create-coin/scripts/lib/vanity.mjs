// The three.ws on-chain brand mark — self-contained mirror for this skill.
//
// This skill ships as a standalone Agent Skill package (its own package.json /
// lockfile / manifest) and is distributed independently of the repo, so it
// cannot import the canonical brand module at src/solana/vanity/brand.js. The
// mark string below is the ONE local source of truth for the package — mirror
// it, never re-hardcode '3ws' anywhere else in these scripts.
//
// Canonical definition (keep in sync): src/solana/vanity/brand.js → THREE_WS_MARK
export const THREE_WS_MARK = "3ws";

/**
 * True when a Base58 mint address carries the three.ws mark (case-insensitive
 * prefix). Mirrors hasThreeWsMark() in src/solana/vanity/brand.js.
 * @param {unknown} address
 * @returns {boolean}
 */
export function hasThreeWsMark(address) {
  if (typeof address !== "string" || address.length < THREE_WS_MARK.length) return false;
  return address.slice(0, THREE_WS_MARK.length).toLowerCase() === THREE_WS_MARK.toLowerCase();
}

/**
 * Grind a fresh Solana mint keypair whose address carries the three.ws mark.
 *
 * Pure-JS grind (repeated Keypair.generate) — no WASM/worker pool to keep the
 * package self-contained. A 3-char case-insensitive prefix is ~1-in-49k, which
 * clears in well under a minute on the throwaway-keypair path. A launch is a
 * deliberate, infrequent action, so the wait is acceptable; progress is logged
 * to stderr so the operator sees the grind working.
 *
 * @param {(typeof import("@solana/web3.js"))["Keypair"]} Keypair
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.onProgress]  Called periodically with a status line.
 * @returns {import("@solana/web3.js").Keypair}
 */
export function grindMarkedMint(Keypair, opts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    const kp = Keypair.generate();
    attempts++;
    if (hasThreeWsMark(kp.publicKey.toBase58())) {
      if (onProgress) {
        onProgress(`marked mint ${kp.publicKey.toBase58()} (${attempts} attempts, ${Date.now() - startedAt}ms)`);
      }
      return kp;
    }
    if (onProgress && attempts % 5000 === 0) {
      onProgress(`grinding ${THREE_WS_MARK}… ${attempts} attempts, ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }
  }
}
