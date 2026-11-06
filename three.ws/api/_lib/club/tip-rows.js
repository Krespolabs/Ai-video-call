// Shape a club_tips row for the free tip feeds (/api/club/tips and its SSE
// stream).
//
// Two things are added to the stored row:
//
//   agent        true when the payer is a registered platform wallet
//                (x402_ring_wallets: the ring payer and the roster agents).
//                The queries compute it as `is_agent`; the /club page draws
//                those tips as agent tips and never as a person in the room,
//                and only a person's tip puts a dancer through a routine.
//   choreography the style's duration, audio loop, pole flag and clip sequence
//                (api/_lib/club/styles.js), so a spectator's screen replays
//                exactly the routine the payer bought rather than guessing
//                from the single `clip` column.

import { styleChoreography } from './styles.js';

/**
 * @param {Record<string, any>} row  a club_tips row plus the `is_agent` column
 */
export function shapeTipRow(row) {
	const { is_agent: isAgent, ...rest } = row;
	const out = { ...rest, agent: isAgent === true };
	const chor = styleChoreography(row.dance);
	if (chor) Object.assign(out, chor);
	return out;
}
