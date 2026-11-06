// Canonical client-side catalog for the one-click stylization filters.
//
// Mirrors workers/stylize STYLE_CATALOG and api/forge-stylize.js STYLE_BOUNDS —
// keep the keys, bounds, and copy in lockstep with those. Each entry carries the
// human-facing copy, its single density knob (bounds + label), and a compact
// inline SVG that depicts the style on a generic form for the gallery thumbnail.
//
// Adding a filter is a matter of appending here, registering its transform in the
// worker, and widening the enum/bounds in forge-stylize.js + the MCP tool schema.

const icon = {
	// Stacked grid of cubes — the blocky voxel rebuild.
	voxel: `
		<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
			<g stroke="currentColor" stroke-width="2" stroke-linejoin="round">
				<rect x="12" y="28" width="13" height="13" rx="1"/>
				<rect x="25" y="28" width="13" height="13" rx="1"/>
				<rect x="38" y="28" width="13" height="13" rx="1"/>
				<rect x="19" y="15" width="13" height="13" rx="1"/>
				<rect x="32" y="15" width="13" height="13" rx="1"/>
				<rect x="25" y="41" width="13" height="13" rx="1"/>
			</g>
		</svg>`,
	// Bricks with studs on the top face.
	brick: `
		<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
			<g stroke="currentColor" stroke-width="2" stroke-linejoin="round">
				<circle cx="24" cy="22" r="3" fill="currentColor" stroke="none"/>
				<circle cx="40" cy="22" r="3" fill="currentColor" stroke="none"/>
				<rect x="16" y="26" width="32" height="14" rx="2"/>
				<circle cx="20" cy="40" r="2.4" fill="currentColor" stroke="none"/>
				<circle cx="44" cy="40" r="2.4" fill="currentColor" stroke="none"/>
				<rect x="14" y="42" width="36" height="12" rx="2"/>
			</g>
		</svg>`,
	// Strut-and-node lattice — open Voronoi shell.
	voronoi: `
		<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
			<g stroke="currentColor" stroke-width="2" stroke-linejoin="round">
				<path d="M20 18 L44 16 L52 34 L38 50 L16 44 L12 26 Z"/>
				<path d="M20 18 L32 32 M44 16 L32 32 M52 34 L32 32 M38 50 L32 32 M16 44 L32 32 M12 26 L32 32"/>
			</g>
			<g fill="currentColor">
				<circle cx="20" cy="18" r="2.6"/><circle cx="44" cy="16" r="2.6"/>
				<circle cx="52" cy="34" r="2.6"/><circle cx="38" cy="50" r="2.6"/>
				<circle cx="16" cy="44" r="2.6"/><circle cx="12" cy="26" r="2.6"/>
				<circle cx="32" cy="32" r="3"/>
			</g>
		</svg>`,
	// Hard facets — low-poly flat shading.
	lowpoly: `
		<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
			<g stroke="currentColor" stroke-width="2" stroke-linejoin="round">
				<path d="M32 12 L50 26 L42 48 L20 46 L14 24 Z"/>
				<path d="M32 12 L14 24 L26 34 Z" fill="currentColor" fill-opacity="0.16"/>
				<path d="M32 12 L50 26 L34 30 Z" fill="currentColor" fill-opacity="0.28"/>
				<path d="M26 34 L20 46 L34 42 Z" fill="currentColor" fill-opacity="0.10"/>
				<path d="M34 30 L42 48 L34 42 Z" fill="currentColor" fill-opacity="0.22"/>
				<path d="M32 12 L26 34 L34 30 Z"/>
				<path d="M26 34 L34 42 L34 30 Z"/>
			</g>
		</svg>`,
};

export const STYLIZE_FILTERS = [
	{
		key: 'voxel',
		name: 'Voxel',
		blurb: 'Blocky cubes on a 3D grid — a clean Minecraft-style rebuild.',
		resolution: { label: 'Grid resolution', def: 32, min: 8, max: 96 },
		icon: icon.voxel,
	},
	{
		key: 'brick',
		name: 'Brick',
		blurb: 'Voxels topped with studs — a buildable toy-brick look.',
		resolution: { label: 'Brick resolution', def: 24, min: 8, max: 64 },
		icon: icon.brick,
	},
	{
		key: 'voronoi',
		name: 'Voronoi shell',
		blurb: 'An open lattice of struts and nodes — light and sculptural.',
		resolution: { label: 'Cell density', def: 48, min: 12, max: 120 },
		icon: icon.voronoi,
	},
	{
		key: 'lowpoly',
		name: 'Low-poly',
		blurb: 'Crisp facets with hard flat shading — stylized game-asset look.',
		resolution: { label: 'Detail', def: 40, min: 8, max: 120 },
		icon: icon.lowpoly,
	},
];

export const STYLIZE_FILTER_BY_KEY = Object.fromEntries(
	STYLIZE_FILTERS.map((f) => [f.key, f]),
);
