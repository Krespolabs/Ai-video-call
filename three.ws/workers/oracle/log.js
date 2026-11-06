// Oracle worker — minimal structured logger. No deps; timestamps + level prefix.
const ts = () => new Date().toISOString();
export const log = {
	info: (...a) => console.log(`[oracle ${ts()}]`, ...a),
	warn: (...a) => console.warn(`[oracle ${ts()}] WARN`, ...a),
	error: (...a) => console.error(`[oracle ${ts()}] ERROR`, ...a),
};
