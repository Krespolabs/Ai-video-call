// Axios variant of buyer-fetch (USE-22).
//
// Same surface as x402-buyer-fetch.js — `caps`, `signPayment`,
// `preferNetwork` — but wraps an axios instance so callers in the
// existing axios-based code paths can adopt cap enforcement without
// rewriting to fetch. The cap install + ledger rollback semantics
// match the fetch helper exactly.

import { enforceCap, commit, rollbackReservation } from './x402-spending-cap.js';
import { BUILDER_CODE } from './x402-builder-code.js';
import { env } from './env.js';

function selectRequirement(challenge, prefer) {
	const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
	if (typeof prefer === 'function') {
		const picked = prefer(accepts);
		if (picked) return picked;
	}
	if (typeof prefer === 'string') {
		const found = accepts.find((a) => a.network === prefer);
		if (found) return found;
	}
	return accepts[0] || null;
}

function ensureBuilderCodeEcho(challenge, paymentPayload) {
	const declared = challenge?.extensions?.[BUILDER_CODE];
	const declaredA = declared?.info?.a;
	if (!declaredA) return paymentPayload;
	const existing = paymentPayload.extensions || {};
	const existingBlock = existing[BUILDER_CODE] || {};
	const echo = { ...existingBlock, a: declaredA };
	if (env.X402_BUILDER_CODE_WALLET && !echo.w) {
		echo.w = env.X402_BUILDER_CODE_WALLET;
	}
	paymentPayload.extensions = { ...existing, [BUILDER_CODE]: echo };
	return paymentPayload;
}

function b64encode(obj) {
	return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function b64decode(s) {
	if (!s) return null;
	try {
		return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
	} catch {
		return null;
	}
}

// Wrap an axios instance with one extra method, `requestPaid(config)`, that
// performs the cap-enforced 402 dance. We avoid mutating the global axios
// default; callers pass an already-constructed instance (or `axios` itself
// if they don't care about isolation).
//
// Required config fields beyond axios's normal shape:
//   signPayment({ requirement, challenge }) — returns paymentPayload
//   caps                                     — optional, same as enforceCap
//   preferNetwork                            — optional, network selector
export function wrapAxiosWithPaidRequest(axiosInstance) {
	if (!axiosInstance || typeof axiosInstance.request !== 'function') {
		throw new Error('wrapAxiosWithPaidRequest: axios instance required');
	}

	async function requestPaid(config) {
		const { caps, signPayment, preferNetwork, ...axiosConfig } = config;
		if (typeof signPayment !== 'function') {
			throw new Error('requestPaid: signPayment({ requirement }) callback is required');
		}
		// axios throws on non-2xx by default; toggle validateStatus so we can
		// see the 402 challenge.
		const probe = await axiosInstance.request({
			...axiosConfig,
			validateStatus: () => true,
		});
		if (probe.status !== 402) {
			return probe;
		}
		const challenge =
			(typeof probe.data === 'object' && probe.data) ||
			b64decode(probe.headers?.['payment-required']);
		if (!challenge || !Array.isArray(challenge.accepts)) {
			const err = new Error('invalid_402_body');
			err.response = probe;
			throw err;
		}
		const requirement = selectRequirement(challenge, preferNetwork);
		if (!requirement) {
			const err = new Error('no_acceptable_requirement');
			err.response = probe;
			throw err;
		}

		let reservation = null;
		if (caps) {
			const verdict = await enforceCap({ requirement, opts: caps });
			if (verdict.abort) {
				const err = new Error(verdict.reason);
				err.code = 'cap_exceeded';
				err.abort = true;
				throw err;
			}
			reservation = verdict.reservation;
		}

		let paymentPayload;
		try {
			paymentPayload = await signPayment({ requirement, challenge });
		} catch (err) {
			if (reservation) await rollbackReservation(reservation).catch(() => undefined);
			throw err;
		}
		ensureBuilderCodeEcho(challenge, paymentPayload);

		const xPayment = b64encode(paymentPayload);
		try {
			const paid = await axiosInstance.request({
				...axiosConfig,
				headers: { ...(axiosConfig.headers || {}), 'X-PAYMENT': xPayment },
				validateStatus: () => true,
			});
			if (paid.status >= 200 && paid.status < 300) {
				if (reservation) {
					await commit(reservation, {
						network: requirement.network,
						asset: requirement.asset,
					});
				}
				paid.x402Payment = paymentPayload;
				paid.x402Settled = b64decode(paid.headers?.['x-payment-response']);
				return paid;
			}
			if (reservation) await rollbackReservation(reservation).catch(() => undefined);
			return paid;
		} catch (err) {
			if (reservation) await rollbackReservation(reservation).catch(() => undefined);
			throw err;
		}
	}

	const wrapped = Object.create(axiosInstance);
	wrapped.requestPaid = requestPaid;
	return wrapped;
}
