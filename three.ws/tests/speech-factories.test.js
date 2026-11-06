import { describe, it, expect } from 'vitest';
import {
	createTTS,
	createSTT,
	BrowserTTS,
	BrowserSTT,
	ElevenLabsTTS,
} from '../src/runtime/speech.js';

describe('createTTS', () => {
	it('returns a BrowserTTS for provider "browser"', () => {
		const tts = createTTS({ provider: 'browser' });
		expect(tts).toBeInstanceOf(BrowserTTS);
	});

	it('returns an ElevenLabsTTS for provider "elevenlabs"', () => {
		const tts = createTTS({ provider: 'elevenlabs', voiceId: 'test-voice' });
		expect(tts).toBeInstanceOf(ElevenLabsTTS);
	});

	it('returns null for provider "none"', () => {
		expect(createTTS({ provider: 'none' })).toBeNull();
	});

	it('defaults to BrowserTTS when no provider is given', () => {
		expect(createTTS({})).toBeInstanceOf(BrowserTTS);
	});

	it('throws an honest error for an unknown provider', () => {
		expect(() => createTTS({ provider: 'azure' })).toThrowError(
			/Unknown TTS provider "azure"\..*browser.*elevenlabs/,
		);
	});
});

describe('ElevenLabsTTS defaults', () => {
	it('requires a voiceId', () => {
		expect(() => new ElevenLabsTTS({})).toThrowError(/requires voiceId/);
	});

	it('defaults to the low-latency flash model', () => {
		expect(new ElevenLabsTTS({ voiceId: 'v' }).modelId).toBe('eleven_flash_v2_5');
	});

	it('uses ElevenLabs recommended voice-setting defaults', () => {
		const tts = new ElevenLabsTTS({ voiceId: 'v' });
		expect(tts.stability).toBe(0.5);
		expect(tts.similarityBoost).toBe(0.75);
		expect(tts.useSpeakerBoost).toBe(true);
	});

	it('lets callers override model and settings per instance', () => {
		const tts = new ElevenLabsTTS({
			voiceId: 'v',
			modelId: 'eleven_multilingual_v2',
			stability: 0.2,
			similarityBoost: 0.9,
			useSpeakerBoost: false,
		});
		expect(tts.modelId).toBe('eleven_multilingual_v2');
		expect(tts.stability).toBe(0.2);
		expect(tts.similarityBoost).toBe(0.9);
		expect(tts.useSpeakerBoost).toBe(false);
	});
});

describe('createSTT', () => {
	it('returns a BrowserSTT for provider "browser"', () => {
		expect(createSTT({ provider: 'browser' })).toBeInstanceOf(BrowserSTT);
	});

	it('returns null for provider "none"', () => {
		expect(createSTT({ provider: 'none' })).toBeNull();
	});

	it('defaults to BrowserSTT when no provider is given', () => {
		expect(createSTT({})).toBeInstanceOf(BrowserSTT);
	});

	it('throws an honest error for an unknown provider', () => {
		expect(() => createSTT({ provider: 'deepgram' })).toThrowError(
			/Unknown STT provider "deepgram"\..*browser/,
		);
	});
});
