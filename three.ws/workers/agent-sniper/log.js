// agent-sniper — structured logging.
//
// One JSON line per event so the worker's stdout drops straight into the
// existing Cloud Run / Vercel log search ([agent-sniper] prefix) without a
// parser. Secrets (keypairs, encrypted blobs) must NEVER be passed here.

function emit(level, msg, fields) {
	const line = { t: new Date().toISOString(), level, tag: 'agent-sniper', msg };
	if (fields && typeof fields === 'object') Object.assign(line, fields);
	const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
	out.write(JSON.stringify(line) + '\n');
}

export const log = {
	info: (msg, fields) => emit('info', msg, fields),
	warn: (msg, fields) => emit('warn', msg, fields),
	error: (msg, fields) => emit('error', msg, fields),
	trade: (msg, fields) => emit('info', msg, { ...fields, event: 'trade' }),
};
