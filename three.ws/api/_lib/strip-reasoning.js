// Reasoning-trace stripper for model output.
//
// Several open reasoning models (NVIDIA Nemotron, DeepSeek-R1, QwQ, and friends)
// emit their chain-of-thought inline, wrapped in <think>…</think> (or
// <thinking>, <reason>, <reasoning>) before the actual answer. That trace is
// useful internally but must never reach a chat UI — it leaks the model's
// scratch work and reads as broken output.
//
// This module removes those tagged blocks. Two entry points:
//
//   • stripReasoning(text)        — clean a complete string (trimmed).
//   • createReasoningStripper()   — a streaming filter for token-by-token
//                                   output, where a tag can span SSE chunk
//                                   boundaries. push(chunk) returns the safe
//                                   text to emit so far; flush() returns any
//                                   trailing safe text once the stream ends.
//
// The streaming filter holds back only the minimal tail that could be the start
// of a tag, so normal text flows through with near-zero latency and a tag split
// across chunks (e.g. "<thi" + "nk>") is still caught.

const OPENERS = ['<think>', '<thinking>', '<reason>', '<reasoning>'];
const CLOSERS = ['</think>', '</thinking>', '</reason>', '</reasoning>'];

// Earliest occurrence of any tag in `tags` within the (already lowercased)
// haystack. Returns { i, tag } with i === -1 when none is present.
function earliestTag(hayLower, tags) {
	let best = -1;
	let bestTag = null;
	for (const t of tags) {
		const i = hayLower.indexOf(t);
		if (i !== -1 && (best === -1 || i < best)) {
			best = i;
			bestTag = t;
		}
	}
	return { i: best, tag: bestTag };
}

// Length of the longest suffix of `sLower` that is a proper, non-empty prefix of
// some tag in `tags`. That suffix might be the beginning of a tag whose
// remainder arrives in the next chunk, so the streaming filter must hold it back
// rather than emit (when scanning for openers) or rescan it (for closers).
function partialTailLength(sLower, tags) {
	let max = 0;
	for (const t of tags) {
		const lim = Math.min(t.length - 1, sLower.length);
		for (let k = lim; k > 0; k--) {
			if (sLower.endsWith(t.slice(0, k))) {
				if (k > max) max = k;
				break;
			}
		}
	}
	return max;
}

// Streaming reasoning-trace filter. Stateful across calls.
//   push(chunk) -> string   safe text to emit for this chunk (may be '')
//   flush()     -> string   trailing safe text after the final chunk
export function createReasoningStripper() {
	let buffer = '';
	let inside = false; // currently inside a reasoning block (content discarded)

	function push(chunk) {
		if (!chunk) return '';
		buffer += chunk;
		let out = '';
		for (;;) {
			const lower = buffer.toLowerCase();
			if (!inside) {
				const { i, tag } = earliestTag(lower, OPENERS);
				if (i !== -1) {
					out += buffer.slice(0, i); // text before the opener is real
					buffer = buffer.slice(i + tag.length);
					inside = true;
					continue;
				}
				// No complete opener. Emit everything except a tail that could be
				// the start of one arriving next chunk.
				const keep = partialTailLength(lower, OPENERS);
				out += buffer.slice(0, buffer.length - keep);
				buffer = keep ? buffer.slice(buffer.length - keep) : '';
				break;
			}
			const { i, tag } = earliestTag(lower, CLOSERS);
			if (i !== -1) {
				buffer = buffer.slice(i + tag.length); // drop trace + closer
				inside = false;
				continue;
			}
			// Still inside the trace: discard it, but keep a tail that could be the
			// start of a closer split across chunks.
			const keep = partialTailLength(lower, CLOSERS);
			buffer = keep ? buffer.slice(buffer.length - keep) : '';
			break;
		}
		return out;
	}

	function flush() {
		if (inside) {
			// Unterminated reasoning block: everything left is trace — drop it.
			buffer = '';
			return '';
		}
		const out = buffer; // any held partial tail was real text after all
		buffer = '';
		return out;
	}

	return { push, flush };
}

// Remove tagged reasoning blocks from a complete string and trim the result.
// Built on the streaming filter so behavior is identical to the live chat path.
export function stripReasoning(text) {
	if (!text) return text ?? '';
	const s = createReasoningStripper();
	return (s.push(text) + s.flush()).trim();
}
