# Anchor campaign proof

Every anchor campaign in [`campaigns.csv`](../campaigns.csv) leads with visible proof (see
"The campaign format" in the [command center](../README.md)). This folder holds that proof,
captured from the live production site in a real Chromium, so nobody has to take screenshots
by hand on posting day.

## Regenerate

```bash
node scripts/capture-campaign-proof.mjs                              # every anchor row
node scripts/capture-campaign-proof.mjs --only MKT-2026-10-NVIDIA-DH # one campaign
node scripts/capture-campaign-proof.mjs --no-video                   # stills only
node scripts/capture-campaign-proof.mjs --base http://localhost:3000 # the working tree
```

The script reads the anchor rows of `campaigns.csv`, opens each three.ws `anchor_proof` URL,
waits for the network to settle and any WebGL canvas to paint, and writes into
`<campaign_id>/`:

| File | What it is | Use it for |
| --- | --- | --- |
| `desktop@2x.png` | 1600x900 viewport at 2x (3200x1800), lossless | Partner-domain articles, decks, press |
| `x-1600x900.jpg` | The same frame at exactly 1600x900, JPEG under 5 MB | The X anchor post and Telegram |
| `mobile@3x.png` | 390x844 phone viewport at 3x (1170x2532) | LinkedIn, community posts, mobile proof |
| `motion-15s.mp4` | 15 seconds of the running surface, H.264, faststart, under 8 MB | Social clips on surfaces that move |

Floating site chrome (the getting-started stack, the walking companion, the language
button) is hidden so the product surface fills the frame. Nothing on the surface is edited.
Each campaign's recipe (what it shows, whether it records a clip, how it is framed) lives in
the `RECIPES` table at the top of the script; a new anchor row needs one entry there.

[`manifest.json`](./manifest.json) records every file's byte size, sha256, dimensions,
duration, source URL, and capture time. The tables below are generated from it.

## Commit gate

three.ws only promotes $THREE. When a captured frame shows the name of another coin or token,
the script prints the terms it saw. The owner approved (2026-09-18) proof media that shows the
payment rails a three.ws page prices in, USDC and SOL (the `APPROVED_TOKEN_TERMS` set in the
script). Any other token name marks the file `gated` in the manifest: it stays on disk, is not
committed until the owner approves that specific content, and is listed below as held, without
a link.

## Assets

<!-- assets:start -->
| Campaign | File | Dimensions | Duration | Size | Captured URL | Capture date | What it shows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MKT-2026-09-IBM-EVENT | [desktop@1x.png](./MKT-2026-09-IBM-EVENT/desktop@1x.png) | 1600x900 | still | 0.10 MB | https://three.ws/play | 2026-09-18 | Desktop hero at 1600x900 (1x): The live 3D world at /play, the venue for the IBM Community user-group event |
| MKT-2026-09-IBM-EVENT | [x-1600x900.jpg](./MKT-2026-09-IBM-EVENT/x-1600x900.jpg) | 1600x900 | still | 0.05 MB | https://three.ws/play | 2026-09-18 | X post still, 16:9 JPEG under 5 MB: The live 3D world at /play, the venue for the IBM Community user-group event |
| MKT-2026-09-IBM-EVENT | [motion-15s.mp4](./MKT-2026-09-IBM-EVENT/motion-15s.mp4) | 1600x900 | 15s | 0.14 MB | https://three.ws/play | 2026-09-18 | 15 second H.264 recording of the live surface: The live 3D world at /play, the venue for the IBM Community user-group event |
| MKT-2026-09-IBM-EVENT | [mobile@2x.png](./MKT-2026-09-IBM-EVENT/mobile@2x.png) | 780x1688 | still | 0.11 MB | https://three.ws/play | 2026-09-18 | Mobile at 390x844 (2x): The live 3D world at /play, the venue for the IBM Community user-group event |
| MKT-2026-09-OPENAI-STUDIO | [desktop@2x.png](./MKT-2026-09-OPENAI-STUDIO/desktop@2x.png) | 3200x1800 | still | 0.21 MB | https://three.ws/openai | 2026-09-18 | Desktop hero at 1600x900 (2x): The OpenAI Select Partner page: 3D Studio inside ChatGPT, keyless |
| MKT-2026-09-OPENAI-STUDIO | [x-1600x900.jpg](./MKT-2026-09-OPENAI-STUDIO/x-1600x900.jpg) | 1600x900 | still | 0.08 MB | https://three.ws/openai | 2026-09-18 | X post still, 16:9 JPEG under 5 MB: The OpenAI Select Partner page: 3D Studio inside ChatGPT, keyless |
| MKT-2026-09-OPENAI-STUDIO | [mobile@3x.png](./MKT-2026-09-OPENAI-STUDIO/mobile@3x.png) | 1170x2532 | still | 0.21 MB | https://three.ws/openai | 2026-09-18 | Mobile at 390x844 (3x): The OpenAI Select Partner page: 3D Studio inside ChatGPT, keyless |
| MKT-2026-10-NVIDIA-DH | [desktop@1x.png](./MKT-2026-10-NVIDIA-DH/desktop@1x.png) | 1600x900 | still | 0.24 MB | https://three.ws/demos/audio2face | 2026-09-18 | Desktop hero at 1600x900 (1x): The Audio2Face demo: audio driving a 3D face in the browser |
| MKT-2026-10-NVIDIA-DH | [x-1600x900.jpg](./MKT-2026-10-NVIDIA-DH/x-1600x900.jpg) | 1600x900 | still | 0.10 MB | https://three.ws/demos/audio2face | 2026-09-18 | X post still, 16:9 JPEG under 5 MB: The Audio2Face demo: audio driving a 3D face in the browser |
| MKT-2026-10-NVIDIA-DH | [motion-15s.mp4](./MKT-2026-10-NVIDIA-DH/motion-15s.mp4) | 1600x900 | 15s | 0.27 MB | https://three.ws/demos/audio2face | 2026-09-18 | 15 second H.264 recording of the live surface: The Audio2Face demo: audio driving a 3D face in the browser |
| MKT-2026-10-NVIDIA-DH | [mobile@2x.png](./MKT-2026-10-NVIDIA-DH/mobile@2x.png) | 780x1688 | still | 0.29 MB | https://three.ws/demos/audio2face | 2026-09-18 | Mobile at 390x844 (2x): The Audio2Face demo: audio driving a 3D face in the browser |
| MKT-2026-10-CDP-X402 | `desktop@2x.png` (held for owner approval, not committed) | 3200x1800 | still | 0.37 MB | https://three.ws/bazaar | 2026-09-18 | Desktop hero at 1600x900 (2x): The x402 Bazaar: a live catalog of paid APIs an agent can discover and buy |
| MKT-2026-10-CDP-X402 | `x-1600x900.jpg` (held for owner approval, not committed) | 1600x900 | still | 0.12 MB | https://three.ws/bazaar | 2026-09-18 | X post still, 16:9 JPEG under 5 MB: The x402 Bazaar: a live catalog of paid APIs an agent can discover and buy |
| MKT-2026-10-CDP-X402 | [mobile@3x.png](./MKT-2026-10-CDP-X402/mobile@3x.png) | 1170x2532 | still | 0.18 MB | https://three.ws/bazaar | 2026-09-18 | Mobile at 390x844 (3x): The x402 Bazaar: a live catalog of paid APIs an agent can discover and buy |
| MKT-2026-10-AWS-MARKET | [desktop@2x.png](./MKT-2026-10-AWS-MARKET/desktop@2x.png) | 3200x1800 | still | 0.24 MB | https://three.ws/aws | 2026-09-18 | Desktop hero at 1600x900 (2x): The three.ws on AWS page: the AWS Partner software path and procurement story |
| MKT-2026-10-AWS-MARKET | [x-1600x900.jpg](./MKT-2026-10-AWS-MARKET/x-1600x900.jpg) | 1600x900 | still | 0.07 MB | https://three.ws/aws | 2026-09-18 | X post still, 16:9 JPEG under 5 MB: The three.ws on AWS page: the AWS Partner software path and procurement story |
| MKT-2026-10-AWS-MARKET | [mobile@3x.png](./MKT-2026-10-AWS-MARKET/mobile@3x.png) | 1170x2532 | still | 0.22 MB | https://three.ws/aws | 2026-09-18 | Mobile at 390x844 (3x): The three.ws on AWS page: the AWS Partner software path and procurement story |
| MKT-2026-10-ELEVEN-BODY | [desktop@1x.png](./MKT-2026-10-ELEVEN-BODY/desktop@1x.png) | 1600x900 | still | 0.08 MB | https://three.ws/voice | 2026-09-18 | Desktop hero at 1600x900 (1x): The voice page: a voice agent with a speaking, expressive 3D body |
| MKT-2026-10-ELEVEN-BODY | [x-1600x900.jpg](./MKT-2026-10-ELEVEN-BODY/x-1600x900.jpg) | 1600x900 | still | 0.06 MB | https://three.ws/voice | 2026-09-18 | X post still, 16:9 JPEG under 5 MB: The voice page: a voice agent with a speaking, expressive 3D body |
| MKT-2026-10-ELEVEN-BODY | [motion-15s.mp4](./MKT-2026-10-ELEVEN-BODY/motion-15s.mp4) | 1600x900 | 15s | 0.19 MB | https://three.ws/voice | 2026-09-18 | 15 second H.264 recording of the live surface: The voice page: a voice agent with a speaking, expressive 3D body |
| MKT-2026-10-ELEVEN-BODY | [mobile@2x.png](./MKT-2026-10-ELEVEN-BODY/mobile@2x.png) | 780x1688 | still | 0.14 MB | https://three.ws/voice | 2026-09-18 | Mobile at 390x844 (2x): The voice page: a voice agent with a speaking, expressive 3D body |
| MKT-2026-11-GCP-AGENT | [desktop@2x.png](./MKT-2026-11-GCP-AGENT/desktop@2x.png) | 3200x1800 | still | 0.26 MB | https://three.ws/.well-known/agent-card.json | 2026-09-18 | Desktop hero at 1600x900 (2x): The public A2A Agent Card served at /.well-known/agent-card.json |
| MKT-2026-11-GCP-AGENT | [x-1600x900.jpg](./MKT-2026-11-GCP-AGENT/x-1600x900.jpg) | 1600x900 | still | 0.09 MB | https://three.ws/.well-known/agent-card.json | 2026-09-18 | X post still, 16:9 JPEG under 5 MB: The public A2A Agent Card served at /.well-known/agent-card.json |
| MKT-2026-11-GCP-AGENT | [mobile@3x.png](./MKT-2026-11-GCP-AGENT/mobile@3x.png) | 1170x2531 | still | 0.31 MB | https://three.ws/.well-known/agent-card.json | 2026-09-18 | Mobile at 390x844 (3x): The public A2A Agent Card served at /.well-known/agent-card.json |
| MKT-2026-11-QUICKNODE | [desktop@2x.png](./MKT-2026-11-QUICKNODE/desktop@2x.png) | 3200x1800 | still | 0.39 MB | https://three.ws/docs/solana | 2026-09-18 | Desktop hero at 1600x900 (2x): The Solana agents doc, Networks section: the production RPC failover chain |
| MKT-2026-11-QUICKNODE | [x-1600x900.jpg](./MKT-2026-11-QUICKNODE/x-1600x900.jpg) | 1600x900 | still | 0.16 MB | https://three.ws/docs/solana | 2026-09-18 | X post still, 16:9 JPEG under 5 MB: The Solana agents doc, Networks section: the production RPC failover chain |
| MKT-2026-11-QUICKNODE | [mobile@3x.png](./MKT-2026-11-QUICKNODE/mobile@3x.png) | 1170x2532 | still | 0.30 MB | https://three.ws/docs/solana | 2026-09-18 | Mobile at 390x844 (3x): The Solana agents doc, Networks section: the production RPC failover chain |
| MKT-2026-11-IBM-WORLD-2 | [desktop@1x.png](./MKT-2026-11-IBM-WORLD-2/desktop@1x.png) | 1600x900 | still | 0.11 MB | https://three.ws/play | 2026-09-18 | Desktop hero at 1600x900 (1x): The live 3D world at /play, where the second IBM session runs the tool-purchase demo |
| MKT-2026-11-IBM-WORLD-2 | [x-1600x900.jpg](./MKT-2026-11-IBM-WORLD-2/x-1600x900.jpg) | 1600x900 | still | 0.05 MB | https://three.ws/play | 2026-09-18 | X post still, 16:9 JPEG under 5 MB: The live 3D world at /play, where the second IBM session runs the tool-purchase demo |
| MKT-2026-11-IBM-WORLD-2 | [motion-15s.mp4](./MKT-2026-11-IBM-WORLD-2/motion-15s.mp4) | 1600x900 | 15s | 0.14 MB | https://three.ws/play | 2026-09-18 | 15 second H.264 recording of the live surface: The live 3D world at /play, where the second IBM session runs the tool-purchase demo |
| MKT-2026-11-IBM-WORLD-2 | [mobile@2x.png](./MKT-2026-11-IBM-WORLD-2/mobile@2x.png) | 780x1688 | still | 0.11 MB | https://three.ws/play | 2026-09-18 | Mobile at 390x844 (2x): The live 3D world at /play, where the second IBM session runs the tool-purchase demo |
<!-- assets:end -->

## Findings at capture

Console errors, uncaught exceptions, failed same-origin requests, error or empty pages, and
WebGL canvases that never painted, as observed on production at capture time.

<!-- findings:start -->
| Campaign | Captured URL | Finding |
| --- | --- | --- |
| MKT-2026-09-IBM-EVENT | https://three.ws/play | No defect observed at capture |
| MKT-2026-09-OPENAI-STUDIO | https://three.ws/openai | No defect observed at capture |
| MKT-2026-10-NVIDIA-DH | https://three.ws/demos/audio2face | No defect observed at capture |
| MKT-2026-10-CDP-X402 | https://three.ws/bazaar | No defect observed at capture |
| MKT-2026-10-AWS-MARKET | https://three.ws/aws | No defect observed at capture |
| MKT-2026-10-ELEVEN-BODY | https://three.ws/voice | no WebGL canvas painted within the settle window |
| MKT-2026-11-GCP-AGENT | https://three.ws/.well-known/agent-card.json | No defect observed at capture |
| MKT-2026-11-QUICKNODE | https://three.ws/docs/solana | No defect observed at capture |
| MKT-2026-11-IBM-WORLD-2 | https://three.ws/play | No defect observed at capture |
<!-- findings:end -->

## Anchors without a three.ws capture

<!-- external:start -->
| Campaign | Proof URL | Why no capture |
| --- | --- | --- |
| MKT-2026-09-OSF | https://github.com/githubevents/open-source-friday/issues/254 | Not a three.ws surface; the proof is owned by the partner or GitHub |
| MKT-2026-11-HF-LOOP | https://huggingface.co/three-ws | Not a three.ws surface; the proof is owned by the partner or GitHub |
| MKT-2026-12-OPEN-SOURCE | https://github.com/nirholas/three.ws | Not a three.ws surface; the proof is owned by the partner or GitHub |
<!-- external:end -->
