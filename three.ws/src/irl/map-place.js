// src/irl/map-place.js — "Pick a spot on the map" placement picker (L2).
//
// Lets a user place a 3D agent at ANY chosen coordinate instead of their exact
// live GPS — the headline privacy win (drop an agent at a café or plaza, never
// your home) and a UX upgrade (place where you're going, or somewhere that
// matters). Self-contained: a bottom sheet with a Leaflet map, a draggable
// marker, place search, a live reverse-geocoded label, and fully designed
// loading / error / no-results states. Resolves via `onConfirm({lat,lng,label})`.
//
// Reuses the single shared Leaflet stack + Nominatim helpers (shared/leaflet-loader)
// so there is never a second map stack. The map is the ONLY thing that can fail
// hard here, and it fails into a retryable state — never a blank rectangle.

import { loadLeaflet, reverseGeocode, searchPlaces } from '../shared/leaflet-loader.js';

const STYLE_ID = 'irlmp-styles';

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = `
.irlmp-root{position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-end;justify-content:center;}
.irlmp-backdrop{position:absolute;inset:0;background:rgba(4,6,12,.62);backdrop-filter:blur(2px);animation:irlmp-fade .2s ease}
.irlmp-sheet{position:relative;width:100%;max-width:560px;max-height:88vh;display:flex;flex-direction:column;
  background:#0c0f17;border:1px solid #232838;border-bottom:none;border-radius:18px 18px 0 0;
  box-shadow:0 -8px 40px rgba(0,0,0,.55);overflow:hidden;animation:irlmp-rise .26s cubic-bezier(.2,.8,.2,1)}
@media(min-width:600px){.irlmp-root{align-items:center}.irlmp-sheet{border-radius:18px;border-bottom:1px solid #232838}}
@keyframes irlmp-rise{from{transform:translateY(14px);opacity:.4}to{transform:translateY(0);opacity:1}}
@keyframes irlmp-fade{from{opacity:0}to{opacity:1}}
.irlmp-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;flex-shrink:0}
.irlmp-title{font:600 15px/1.2 system-ui,sans-serif;color:#eef1f7}
.irlmp-x{appearance:none;background:none;border:none;color:#8b93a7;font-size:24px;line-height:1;cursor:pointer;
  width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}
.irlmp-x:hover,.irlmp-x:focus-visible{background:#1a1f2e;color:#eef1f7;outline:none}
.irlmp-search{position:relative;padding:0 16px 10px;flex-shrink:0}
.irlmp-search input{width:100%;box-sizing:border-box;background:#11151f;border:1px solid #2a3042;border-radius:10px;
  color:#eef1f7;font:500 14px/1.3 system-ui,sans-serif;padding:11px 12px;transition:border-color .15s,box-shadow .15s}
.irlmp-search input:focus{outline:none;border-color:#4f7cff;box-shadow:0 0 0 3px rgba(79,124,255,.18)}
.irlmp-results{position:absolute;left:16px;right:16px;top:calc(100% - 4px);z-index:5;background:#11151f;border:1px solid #2a3042;
  border-radius:10px;overflow:hidden;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.irlmp-result{display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid #1b2030;
  color:#dfe3ec;font:500 13px/1.35 system-ui,sans-serif;padding:10px 12px;cursor:pointer;transition:background .12s}
.irlmp-result:last-child{border-bottom:none}
.irlmp-result:hover,.irlmp-result.is-active{background:#1a2032}
.irlmp-result small{display:block;color:#8b93a7;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.irlmp-results-empty{padding:12px;color:#8b93a7;font:500 13px/1.4 system-ui,sans-serif;text-align:center}
.irlmp-mapwrap{position:relative;flex:1;min-height:280px;background:#11151f}
.irlmp-map{position:absolute;inset:0}
.irlmp-map .leaflet-control-zoom a{background:#11151f;color:#eef1f7;border-color:#2a3042}
.irlmp-map .leaflet-control-zoom a:hover{background:#1a2032}
.irlmp-map .leaflet-control-attribution{background:rgba(8,10,16,.7);color:#99a;font-size:10px}
.irlmp-map .leaflet-control-attribution a{color:#9cf}
.irlmp-pin-icon{background:none;border:none}
.irlmp-pin{width:36px;height:44px;transform:translateY(-6px);filter:drop-shadow(0 3px 4px rgba(0,0,0,.5))}
.irlmp-overlay{position:absolute;inset:0;z-index:600;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:12px;background:#11151f;color:#aeb6c8;font:500 13px/1.4 system-ui,sans-serif;text-align:center;padding:24px}
.irlmp-overlay.gone{opacity:0;pointer-events:none;transition:opacity .3s}
.irlmp-spin{width:22px;height:22px;border-radius:50%;border:2px solid #2a3042;border-top-color:#4f7cff;animation:irlmp-rot .8s linear infinite}
@keyframes irlmp-rot{to{transform:rotate(360deg)}}
.irlmp-retry{appearance:none;background:#4f7cff;color:#fff;border:none;border-radius:9px;font:600 13px system-ui,sans-serif;
  padding:9px 16px;cursor:pointer;transition:background .15s}
.irlmp-retry:hover{background:#3d6af0}
.irlmp-foot{flex-shrink:0;padding:12px 16px 16px;border-top:1px solid #1b2030;background:#0c0f17}
.irlmp-coords{font:500 12px/1.4 system-ui,sans-serif;color:#aeb6c8;margin-bottom:10px;min-height:17px}
.irlmp-coords b{color:#eef1f7;font-weight:600}
.irlmp-actions{display:flex;gap:10px}
.irlmp-actions button{flex:1;appearance:none;border-radius:11px;font:600 14px system-ui,sans-serif;padding:12px;cursor:pointer;transition:background .15s,opacity .15s,transform .06s}
.irlmp-actions button:active{transform:translateY(1px)}
.irlmp-cancel{background:#1a1f2e;color:#cfd5e3;border:1px solid #2a3042}
.irlmp-cancel:hover{background:#222838}
.irlmp-confirm{background:#4f7cff;color:#fff;border:1px solid #4f7cff}
.irlmp-confirm:hover:not(:disabled){background:#3d6af0}
.irlmp-confirm:disabled{opacity:.45;cursor:not-allowed}
`;
	document.head.appendChild(el);
}

const PIN_SVG = `<svg class="irlmp-pin" viewBox="0 0 24 30" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 0C5.9 0 1 4.9 1 11c0 7.5 9.4 17.6 9.8 18a1.6 1.6 0 0 0 2.4 0C13.6 28.6 23 18.5 23 11 23 4.9 18.1 0 12 0Z" fill="#4f7cff" stroke="#dfe6ff" stroke-width="1.4"/>
  <circle cx="12" cy="11" r="4" fill="#fff"/></svg>`;

const fmt = (v) => (Math.round(v * 1e5) / 1e5).toFixed(5);

/**
 * Open the placement picker. Returns nothing; calls `onConfirm({lat,lng,label})`
 * when the user confirms a point, or `onCancel()` when they dismiss it.
 * @param {{start?:{lat:number,lng:number}, onConfirm:Function, onCancel?:Function}} opts
 */
export function openMapPlacePicker({ start = null, onConfirm, onCancel } = {}) {
	ensureStyles();

	const root = document.createElement('div');
	root.className = 'irlmp-root';
	root.setAttribute('role', 'dialog');
	root.setAttribute('aria-modal', 'true');
	root.setAttribute('aria-label', 'Pick a spot on the map');
	root.innerHTML = `
		<div class="irlmp-backdrop" data-cancel></div>
		<div class="irlmp-sheet">
			<div class="irlmp-head">
				<div class="irlmp-title">Pick a spot on the map</div>
				<button class="irlmp-x" type="button" data-cancel aria-label="Cancel">×</button>
			</div>
			<div class="irlmp-search">
				<input type="search" autocomplete="off" placeholder="Search a place — “Dolores Park, SF”" aria-label="Search for a place" />
				<div class="irlmp-results" role="listbox" hidden></div>
			</div>
			<div class="irlmp-mapwrap">
				<div class="irlmp-map"></div>
				<div class="irlmp-overlay" data-state>
					<div class="irlmp-spin"></div><div>Loading map…</div>
				</div>
			</div>
			<div class="irlmp-foot">
				<div class="irlmp-coords" aria-live="polite">Drag the pin or tap the map to choose a spot.</div>
				<div class="irlmp-actions">
					<button class="irlmp-cancel" type="button" data-cancel>Cancel</button>
					<button class="irlmp-confirm" type="button" disabled>Place here</button>
				</div>
			</div>
		</div>`;
	document.body.appendChild(root);
	const prevOverflow = document.body.style.overflow;
	document.body.style.overflow = 'hidden';

	const searchInput = root.querySelector('.irlmp-search input');
	const resultsEl   = root.querySelector('.irlmp-results');
	const mapEl       = root.querySelector('.irlmp-map');
	const overlay     = root.querySelector('[data-state]');
	const coordsEl    = root.querySelector('.irlmp-coords');
	const confirmBtn  = root.querySelector('.irlmp-confirm');

	let L = null, map = null, marker = null;
	let picked = null;        // { lat, lng }
	let pickedLabel = null;   // reverse-geocoded label string
	let geoSeq = 0;           // guards out-of-order reverse-geocode responses
	let searchSeq = 0;        // guards out-of-order search responses
	let searchAbort = null;
	let destroyed = false;

	const close = (confirmed) => {
		if (destroyed) return;
		destroyed = true;
		document.removeEventListener('keydown', onKey, true);
		try { map?.remove(); } catch { /* leaflet teardown best-effort */ }
		root.remove();
		document.body.style.overflow = prevOverflow;
		if (!confirmed) onCancel?.();
	};

	const onKey = (ev) => {
		if (ev.key === 'Escape') { ev.stopPropagation(); close(false); }
	};
	document.addEventListener('keydown', onKey, true);
	root.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => close(false)));

	// ── Picked-point state ──────────────────────────────────────────────────
	function setPicked(lat, lng) {
		picked = { lat, lng };
		confirmBtn.disabled = false;
		pickedLabel = null;
		coordsEl.innerHTML = `<b>${fmt(lat)}, ${fmt(lng)}</b> · finding place…`;
		const seq = ++geoSeq;
		reverseGeocode(lat, lng).then((label) => {
			if (destroyed || seq !== geoSeq) return;
			pickedLabel = label;
			coordsEl.innerHTML = label
				? `<b>${esc(label)}</b> · ${fmt(lat)}, ${fmt(lng)}`
				: `<b>${fmt(lat)}, ${fmt(lng)}</b>`;
		});
	}

	function moveMarker(lat, lng, recenter) {
		if (!marker) return;
		marker.setLatLng([lat, lng]);
		if (recenter) map.panTo([lat, lng], { animate: true });
		setPicked(lat, lng);
	}

	// ── Map boot (the only hard-failure path) ───────────────────────────────
	async function boot() {
		overlay.classList.remove('gone');
		overlay.innerHTML = `<div class="irlmp-spin"></div><div>Loading map…</div>`;
		try {
			L = await loadLeaflet();
			if (destroyed) return;
			const center = start && Number.isFinite(start.lat) ? [start.lat, start.lng] : [20, 0];
			const zoom   = start && Number.isFinite(start.lat) ? 16 : 3;
			map = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView(center, zoom);
			L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				maxZoom: 19,
				attribution: '© OpenStreetMap',
			}).addTo(map);

			const icon = L.divIcon({ className: 'irlmp-pin-icon', html: PIN_SVG, iconSize: [36, 44], iconAnchor: [18, 40] });
			marker = L.marker(center, { draggable: true, icon, keyboard: true, title: 'Drag to your chosen spot' }).addTo(map);
			marker.on('dragend', () => { const p = marker.getLatLng(); setPicked(p.lat, p.lng); });
			map.on('click', (e) => moveMarker(e.latlng.lat, e.latlng.lng, false));

			// A known start point IS a valid pick; an unknown one waits for the user.
			if (start && Number.isFinite(start.lat)) setPicked(start.lat, start.lng);

			// Leaflet needs a size recalculation after the sheet's open animation.
			setTimeout(() => { try { map.invalidateSize(); } catch {} }, 260);
			overlay.classList.add('gone');
		} catch (err) {
			if (destroyed) return;
			overlay.classList.remove('gone');
			overlay.innerHTML = `<div>Couldn’t load the map.</div>
				<button class="irlmp-retry" type="button">Try again</button>
				<div style="font-size:11px;color:#7b8398">Check your connection and retry.</div>`;
			overlay.querySelector('.irlmp-retry')?.addEventListener('click', boot);
		}
	}

	// ── Search (debounced, abortable, out-of-order safe) ────────────────────
	function renderResults(rows) {
		if (!rows.length) {
			resultsEl.innerHTML = `<div class="irlmp-results-empty">No matching places.</div>`;
			resultsEl.hidden = false;
			return;
		}
		resultsEl.innerHTML = rows.map((r, i) =>
			`<button class="irlmp-result" type="button" role="option" data-i="${i}">${esc(r.short)}<small>${esc(r.label)}</small></button>`
		).join('');
		resultsEl.hidden = false;
		resultsEl.querySelectorAll('.irlmp-result').forEach((btn) => {
			btn.addEventListener('click', () => {
				const r = rows[Number(btn.dataset.i)];
				resultsEl.hidden = true;
				searchInput.value = r.short;
				if (map) { map.setView([r.lat, r.lng], 16, { animate: true }); moveMarker(r.lat, r.lng, false); }
			});
		});
	}

	let searchTimer = null;
	searchInput.addEventListener('input', () => {
		clearTimeout(searchTimer);
		const q = searchInput.value.trim();
		if (q.length < 2) { resultsEl.hidden = true; return; }
		searchTimer = setTimeout(async () => {
			const seq = ++searchSeq;
			try { searchAbort?.abort(); } catch {}
			searchAbort = new AbortController();
			const rows = await searchPlaces(q, { signal: searchAbort.signal });
			if (destroyed || seq !== searchSeq) return;
			renderResults(rows);
		}, 320);
	});
	searchInput.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !resultsEl.hidden) { ev.stopPropagation(); resultsEl.hidden = true; } });
	// Tapping the map area dismisses an open results list.
	mapEl.addEventListener('pointerdown', () => { resultsEl.hidden = true; }, true);

	confirmBtn.addEventListener('click', () => {
		if (!picked) return;
		const out = { lat: picked.lat, lng: picked.lng, label: pickedLabel };
		close(true);
		onConfirm?.(out);
	});

	setTimeout(() => searchInput.focus(), 80);
	boot();
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
