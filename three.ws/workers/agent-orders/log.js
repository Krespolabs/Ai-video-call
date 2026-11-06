// agent-orders — structured, single-line JSON logging. Keypairs/secrets never
// reach here; callers pass only ids, mints, amounts, and reasons.

function emit(level, msg, meta) {
	const rec = { t: new Date().toISOString(), level, msg, ...(meta || {}) };
	const line = JSON.stringify(rec);
	if (level === 'error' || level === 'warn') console.error(line);
	else console.log(line);
}

export const log = {
	info: (msg, meta) => emit('info', msg, meta),
	warn: (msg, meta) => emit('warn', msg, meta),
	error: (msg, meta) => emit('error', msg, meta),
	trade: (msg, meta) => emit('trade', msg, meta),
};
