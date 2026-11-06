-- Per-agent ElevenLabs voice tuning.
--
-- voice_model:    synthesis model id (e.g. eleven_flash_v2_5). NULL = platform default.
-- voice_settings: canonical ElevenLabs voice_settings object
--                 { stability, similarity_boost, style, use_speaker_boost }. NULL = recommended defaults.
--
-- Both are read by the agent runtime (src/agent-resolver.js) and written by
-- PUT /api/agents/:id/voice. NULL keeps existing agents on the defaults.
alter table agent_identities add column if not exists voice_model    text;
alter table agent_identities add column if not exists voice_settings jsonb;
