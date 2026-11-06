# Text to 3D: the free lane, tested end to end

The post says a sentence became a textured 3D model in 106 seconds with no account and no API key. That is a record of one real run, not an estimate.

- **When:** 2026-09-18, 08:51 UTC.
- **Call:** `POST https://three.ws/api/mcp-studio`, tool `forge_free`, arguments `{ "prompt": "a worn leather armchair with brass studs", "tier": "draft" }`, with no credentials of any kind.
- **Result:** a GLB at `https://three.ws/cdn/forge/anon/122077f6-8cc7-46b8-bbca-f38a0d7b2670.glb`, returned 106 seconds after the request was sent.
- **The card** shows that exact model in the three.ws viewer.

The same call is documented for anyone to repeat in `.agents/skills/generate-3d-model/SKILL.md`.
