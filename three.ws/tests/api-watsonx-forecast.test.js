// Unit tests for the Granite Time Series forecast helper
// (api/_lib/watsonx-forecast.js), which the Granite Oracle endpoint depends on.
// Both the IAM token exchange and the /ml/v1/time_series/forecast call are mocked
// through global.fetch, so these run with no network and no credentials. They pin
// the request contract the watsonx.ai TS API expects, the model-selection logic,
// and the response parsing.

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';
import { watsonxConfig } from '../api/_lib/watsonx.js';
import {
	watsonxForecast,
	forecastModelFor,
	FORECAST_MODELS,
} from '../api/_lib/watsonx-forecast.js';

const realFetch = global.fetch;
afterAll(() => {
	global.fetch = realFetch;
});

let fc = null; // captured forecast request

function makeSeries(n) {
	const timestamps = [];
	const values = [];
	const base = Date.UTC(2025, 0, 1) / 1000;
	for (let i = 0; i < n; i++) {
		timestamps.push(new Date((base + i * 3600) * 1000).toISOString());
		values.push(100 + Math.sin(i / 12) * 4);
	}
	return { timestamps, values };
}

beforeEach(() => {
	process.env.WATSONX_API_KEY = 'test-key';
	process.env.WATSONX_PROJECT_ID = 'proj-123';
	delete process.env.WATSONX_SPACE_ID;
	fc = null;
	global.fetch = vi.fn(async (url, opts) => {
		const u = String(url);
		if (u.includes('iam.cloud.ibm.com')) {
			return { ok: true, json: async () => ({ access_token: 'iam-tok', expires_in: 3600 }) };
		}
		if (u.includes('/ml/v1/time_series/forecast')) {
			fc = { url: u, body: JSON.parse(opts.body) };
			const tcol = fc.body.schema.target_columns[0];
			const date = ['2025-01-03T00:00:00.000Z', '2025-01-03T01:00:00.000Z'];
			return {
				ok: true,
				text: async () =>
					JSON.stringify({
						model_id: fc.body.model_id,
						results: [{ date, [tcol]: [120, 121] }],
					}),
			};
		}
		throw new Error(`unexpected fetch: ${u}`);
	});
});

const cfg = () => watsonxConfig();

describe('forecastModelFor / FORECAST_MODELS', () => {
	it('picks the largest model whose context the history can fill', () => {
		expect(forecastModelFor(500)).toBe(FORECAST_MODELS[512]);
		expect(forecastModelFor(512)).toBe(FORECAST_MODELS[512]);
		expect(forecastModelFor(1023)).toBe(FORECAST_MODELS[512]);
		expect(forecastModelFor(1024)).toBe(FORECAST_MODELS[1024]);
		expect(forecastModelFor(1536)).toBe(FORECAST_MODELS[1536]);
		expect(forecastModelFor(5000)).toBe(FORECAST_MODELS[1536]);
	});

	it('maps each context length to its Granite TTM model id', () => {
		expect(FORECAST_MODELS[512]).toBe('ibm/granite-ttm-512-96-r2');
		expect(FORECAST_MODELS[1024]).toBe('ibm/granite-ttm-1024-96-r2');
		expect(FORECAST_MODELS[1536]).toBe('ibm/granite-ttm-1536-96-r2');
	});
});

describe('watsonxForecast', () => {
	it('builds the documented request body and parses the forecast', async () => {
		const { timestamps, values } = makeSeries(512);
		const out = await watsonxForecast(cfg(), { timestamps, values, freq: '1h' });

		// Request contract
		expect(fc.url).toContain('/ml/v1/time_series/forecast');
		expect(fc.url).toContain('version=2025-02-11'); // cfg.tsApiVersion
		const b = fc.body;
		expect(b.model_id).toBe(FORECAST_MODELS[512]); // auto-selected from length
		expect(b.project_id).toBe('proj-123'); // scope
		expect(b.schema).toEqual({
			timestamp_column: 'date',
			freq: '1h',
			target_columns: ['value'],
		});
		expect(b.data.date).toHaveLength(512);
		expect(b.data.value).toHaveLength(512);
		expect(b.parameters).toBeUndefined(); // no predictionLength → omit parameters

		// Response parsing
		expect(out.values).toEqual([120, 121]);
		expect(out.timestamps).toHaveLength(2);
		expect(out.inputWindow).toBe(512);
		expect(out.model).toBe(FORECAST_MODELS[512]);
	});

	it('honors an explicit model, custom target column, and prediction length', async () => {
		const { timestamps, values } = makeSeries(1024);
		const out = await watsonxForecast(cfg(), {
			model: FORECAST_MODELS[1024],
			timestamps,
			values,
			freq: '15min',
			targetColumn: 'price',
			predictionLength: 48,
		});
		expect(fc.body.model_id).toBe(FORECAST_MODELS[1024]);
		expect(fc.body.schema.target_columns).toEqual(['price']);
		expect(fc.body.data.price).toHaveLength(1024);
		expect(fc.body.parameters).toEqual({ prediction_length: 48 });
		expect(out.values).toEqual([120, 121]); // parsed from results[0].price
	});

	it('rejects mismatched or empty arrays before any network call', async () => {
		const { timestamps, values } = makeSeries(512);
		await expect(
			watsonxForecast(cfg(), { timestamps, values: values.slice(1), freq: '1h' }),
		).rejects.toThrow(/equal-length/);
		await expect(
			watsonxForecast(cfg(), { timestamps: [], values: [], freq: '1h' }),
		).rejects.toThrow(/equal-length/);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('surfaces the real upstream status on failure', async () => {
		global.fetch = vi.fn(async (url) => {
			if (String(url).includes('iam.cloud.ibm.com'))
				return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
			return {
				ok: false,
				status: 404,
				text: async () => '{"errors":[{"message":"model not found"}]}',
			};
		});
		const { timestamps, values } = makeSeries(512);
		await expect(watsonxForecast(cfg(), { timestamps, values, freq: '1h' })).rejects.toThrow(
			/watsonx 404: model not found/,
		);
	});
});
