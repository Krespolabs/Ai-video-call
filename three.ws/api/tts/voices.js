// GET /api/tts/voices
//
// The catalog of voices /api/tts/speak can synthesize, so any picker (the
// Walk Avatar extension settings, demo surfaces) lists only voices that will
// actually render. Pure metadata — public, no auth, no metering. `providers`
// reports which synthesis lanes are configured so a client can show whether
// audio is available at all; the voice ids are valid regardless of lane.

import { cors, json, method, wrap } from '../_lib/http.js';
import { TTS_VOICES, DEFAULT_VOICE } from '../_lib/tts-voices.js';
import { nvidiaTtsConfigured } from '../_lib/tts-nvidia.js';
import { env } from '../_lib/env.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const providers = {
		nvidia: nvidiaTtsConfigured(),
		openai: Boolean(env.OPENAI_API_KEY),
	};

	return json(
		res,
		200,
		{
			enabled: providers.nvidia || providers.openai,
			default: DEFAULT_VOICE,
			voices: TTS_VOICES,
			providers,
		},
		{ 'cache-control': 'public, max-age=3600' },
	);
});
