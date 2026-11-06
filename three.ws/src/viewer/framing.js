// Pure framing geometry for a humanoid bounding box — no THREE dependency, so
// it is unit-testable and shared by viewer.setContent (initial framing) and
// viewer.frameContent (re-framing on resize). Both must agree or a resize would
// jump the camera.

/**
 * Vertical framing for a humanoid bounding box.
 *
 * `full` (default) frames the whole body: the look-at sits at the vertical
 * centre and the visible height is the full bounding box. `portrait` crops to
 * roughly head-to-mid-thigh so the avatar fills a wide or short card instead of
 * standing tiny-and-low in it — the read that works best for a small embedded
 * thumbnail. For `full` the result is mathematically identical to the previous
 * inline computation (baseY === vertical centre), so non-portrait embeds are
 * byte-for-byte unchanged.
 *
 * @param {number} bodyHeight  full bounding-box height in world units
 * @param {number} topY        world-y of the top of the head in the working frame
 * @param {'full'|'portrait'} [mode]
 * @returns {{ visH:number, baseY:number }} visible height + look-at y
 */
export function computeFramingExtent(bodyHeight, topY, mode = 'full') {
	if (mode === 'portrait') {
		const PORTRAIT_FRAC = 0.62; // head → ~mid-thigh
		const HEADROOM_FRAC = 0.04; // a little air above the crown
		const visH = bodyHeight * PORTRAIT_FRAC;
		const windowTop = topY + bodyHeight * HEADROOM_FRAC;
		return { visH, baseY: windowTop - visH / 2 };
	}
	return { visH: bodyHeight, baseY: topY - bodyHeight / 2 };
}

/**
 * Effective horizontal extent to frame against, in world units.
 *
 * Camera distance is driven by `max(verticalFit, horizontalFit)`, and the
 * horizontal term reads the bounding-box width. A humanoid's natural standing
 * width (shoulders, arms at the sides) is only ~0.25–0.35× its height, but a
 * rig authored in a T-pose (arms stretched straight out — Mixamo's michelle,
 * xbot, …) measures ~0.85–1.0× its height. Until a retargeted clip lowers the
 * arms, that arms-out box pushes the camera so far back the avatar shrinks to a
 * speck — the "tiny figure stranded at the bottom of the card" bug.
 *
 * In `portrait` mode (a deliberately tight vertical crop for small cards) we cap
 * the width that feeds the distance so an arms-out rest pose can't blow out the
 * frame: the figure fills the card by height and any outstretched arms simply
 * extend past the (overflow-hidden) card edges for the moment before the clip
 * settles them in — vastly better than zooming away from the whole avatar. The
 * cap sits well above any natural standing width, so arms-down bodies (cz,
 * default, every standard avatar-platform rig) are returned unchanged and never re-framed.
 * `full` mode is untouched: it shows the whole body, so arms-out is acceptable.
 *
 * @param {number} bbWidth     bounding-box width in world units
 * @param {number} bodyHeight  full bounding-box height in world units
 * @param {'full'|'portrait'} [mode]
 * @returns {number} width to use when computing horizontal camera fit
 */
export function computeFramingWidth(bbWidth, bodyHeight, mode = 'full') {
	if (mode === 'portrait') {
		const MAX_PORTRAIT_WIDTH_FRAC = 0.55; // > any natural standing width, < a T-pose
		return Math.min(bbWidth, bodyHeight * MAX_PORTRAIT_WIDTH_FRAC);
	}
	return bbWidth;
}
