// Shared avatar-URL sanitizer for the authoritative room (WalkRoom).
//
// We only ever broadcast avatar URLs we'd be willing to load cross-origin: our
// own origins and the public model hosts. Site-relative paths are always fine.
// Everything else — javascript:/data: URLs, arbitrary hosts, oversized strings —
// collapses to '' so a malicious client can't make everyone fetch attacker-
// controlled URLs. Centralized here so the allow-list never drifts between rooms.

const AVATAR_HOST_ALLOW = [
	/(^|\.)three\.ws$/i,
	/(^|\.)r2\.cloudflarestorage\.com$/i,
	/(^|\.)r2\.dev$/i,
	/(^|\.)pump\.fun$/i,
	/(^|\.)githubusercontent\.com$/i,
	// Ready Player Me (W03 character creator): full-body avatars are exported as
	// models.readyplayer.me/<id>.glb. Loadable cross-origin like our own models.
	/(^|\.)readyplayer\.me$/i,
];

export function cleanAvatarUrl(v) {
	if (typeof v !== 'string' || v.length > 1024) return '';
	const s = v.trim();
	if (!s) return '';
	// Site-relative path (e.g. /avatars/default.glb) is always allowed.
	if (s.startsWith('/') && !s.startsWith('//')) return s;
	let u;
	try { u = new URL(s); } catch { return ''; }
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
	return AVATAR_HOST_ALLOW.some((re) => re.test(u.hostname)) ? s : '';
}
