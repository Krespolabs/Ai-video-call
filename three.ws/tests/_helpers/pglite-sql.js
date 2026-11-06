// An in-process Postgres (PGlite) behind the same tagged-template `sql` shape
// api/_lib/db.js exports, for tests that must exercise real SQL semantics:
// check constraints, partial unique indexes, ON CONFLICT inference, jsonb
// operators. Mock api/_lib/db.js with `{ ...actual, sql: db.sql }` and create
// only the tables the code under test touches.
//
// Like the production wrapper, a query is lazy (it runs when awaited) and an
// interpolated sql`...` fragment is inlined with its placeholders renumbered,
// so modules that build column lists or WHERE clauses as fragments work here.

import { PGlite } from '@electric-sql/pglite';

const FRAGMENT = Symbol('pglite-sql-fragment');

function compile(fragment, params) {
	let text = '';
	fragment.strings.forEach((part, i) => {
		text += part;
		if (i >= fragment.values.length) return;
		const v = fragment.values[i];
		if (v && v[FRAGMENT]) {
			text += compile(v, params);
		} else {
			params.push(v instanceof Date ? v.toISOString() : v);
			text += `$${params.length}`;
		}
	});
	return text;
}

export function createPgliteSql() {
	const state = { pg: new PGlite(), calls: [] };
	const run = async (fragment) => {
		const params = [];
		const text = compile(fragment, params);
		state.calls.push(text);
		const out = await state.pg.query(text, params);
		return out.rows;
	};
	const sql = (strings, ...values) => {
		const fragment = { [FRAGMENT]: true, strings, values };
		let promise = null;
		const settle = () => (promise ??= run(fragment));
		fragment.then = (onOk, onErr) => settle().then(onOk, onErr);
		fragment.catch = (onErr) => settle().catch(onErr);
		fragment.finally = (fn) => settle().finally(fn);
		return fragment;
	};
	return {
		sql,
		exec: (ddl) => state.pg.exec(ddl),
		query: (text, params) => state.pg.query(text, params).then((r) => r.rows),
		calls: state.calls,
	};
}
