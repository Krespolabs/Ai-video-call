// agora-citizens — structured, single-line JSON logging. Keypairs/secrets never
// reach here; callers pass only ids, pubkeys, tx signatures, amounts, reasons.

function emit(level, msg, meta) {
	const rec = { t: new Date().toISOString(), w: 'agora-citizens', level, msg, ...(meta || {}) };
	const line = JSON.stringify(rec);
	if (level === 'error' || level === 'warn') console.error(line);
	else console.log(line);
}

export const log = {
	info: (msg, meta) => emit('info', msg, meta),
	warn: (msg, meta) => emit('warn', msg, meta),
	error: (msg, meta) => emit('error', msg, meta),
	loop: (msg, meta) => emit('loop', msg, meta),
};
