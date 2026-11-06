// One-shot GLB handoff between three.ws pages and the Scene Studio (/scene).
//
// /pose bakes the posed keyframe animation into a GLB (mesh + embedded clip)
// and stashes it here, then opens /scene?handoff=1, which takes the payload
// exactly once and loads it as a recordable timeline track.
//
// IndexedDB — not a query string or localStorage — because the payload is a
// binary GLB that can run to several MB. A URL can't carry it, and localStorage
// only holds strings (base64 would inflate it ~33% and risk the ~5MB quota).
// IndexedDB stores the ArrayBuffer directly and survives the page navigation.

const DB_NAME = 'three-ws-scene-handoff';
const STORE = 'handoff';
const KEY = 'pending';

// A handoff older than this is treated as stale and ignored — so a payload left
// behind by an abandoned session never surprise-loads into a fresh /scene visit.
const MAX_AGE_MS = 5 * 60 * 1000;

function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
	});
}

function run(db, mode, fn) {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		const req = fn(tx.objectStore(STORE));
		tx.oncomplete = () => resolve(req ? req.result : undefined);
		tx.onabort = tx.onerror = () =>
			reject(tx.error || new Error('IndexedDB transaction failed'));
	});
}

/**
 * Stash a one-shot handoff for /scene to consume.
 * @param {{ glb: ArrayBuffer, name?: string, animationName?: string }} payload
 */
export async function putSceneHandoff(payload) {
	const db = await openDb();
	try {
		await run(db, 'readwrite', (s) => s.put({ ...payload, createdAt: Date.now() }, KEY));
	} finally {
		db.close();
	}
}

/**
 * Read and delete the pending handoff (one-shot). Returns null when there is
 * none, or when the stored payload is older than MAX_AGE_MS.
 * @returns {Promise<{ glb: ArrayBuffer, name?: string, animationName?: string, createdAt: number } | null>}
 */
export async function takeSceneHandoff() {
	const db = await openDb();
	try {
		const record = await run(db, 'readonly', (s) => s.get(KEY));
		await run(db, 'readwrite', (s) => s.delete(KEY));
		if (!record || !record.glb) return null;
		if (typeof record.createdAt === 'number' && Date.now() - record.createdAt > MAX_AGE_MS) {
			return null;
		}
		return record;
	} finally {
		db.close();
	}
}
