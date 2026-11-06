# three.ws — SperaxOS plugin

Give a SperaxOS agent a body: a rigged 3D avatar, rendered in the chat panel, that
speaks, gestures, and shifts its body language in real time as the agent acts —
bound to an on-chain ERC-8004 identity.

SperaxOS is a LobeChat-lineage host, so this ships as a **standalone plugin**: a
hosted iframe the platform frames directly, plus a small set of LLM-callable tools.
No bundle to submit, no SDK to vendor.

---

## Files

| File                               | Purpose                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`manifest.json`](./manifest.json) | The `plugin.delivery` manifest (`type: standalone`). Served with CORS at `/.well-known/sperax-plugin.json` and verbatim at `/sperax/manifest.json`. |
| [`icon-256.svg`](./icon-256.svg)   | The plugin avatar (`meta.avatar`).                                                                                                                  |
| `/sperax/iframe/`                  | The rendered panel (`ui.url`). Shares `boot.js` with the LobeChat embed; speaks both the `speraxos:` and `lobe-chat:` protocols.                    |
| `/api/chat-plugin/{tool}`          | The gateway-facing tool endpoints (`render-agent`, `speak`, `gesture`, `emote`).                                                                    |

---

## Install (end users)

1. In SperaxOS, open **Plugins → Add Plugin → Custom Plugin**.
2. Paste the manifest URL:
    ```
    https://three.ws/.well-known/sperax-plugin.json
    ```
3. Install, then set your **Agent ID** (a UUID or `@handle` from
   [your dashboard](https://three.ws/dashboard)).
4. The avatar appears in the chat panel and reacts to the agent's tool calls.

---

## How it works

```
SperaxOS host
  │  1. LLM calls a tool (speak / gesture / emote / render_agent)
  │
  ├─ 2a. renders ui.url in an iframe and posts the call to it:
  │      { type: 'speraxos:init-standalone-plugin',
  │        payload: { apiName, arguments }, settings: { agentId } }
  │            ▼
  │      /sperax/iframe/ (boot.js) → <agent-3d> animates the avatar
  │
  └─ 2b. gateway POSTs the arguments to api[].url for the model-facing result:
         POST /api/chat-plugin/speak   (header: Sperax-Plugin-Settings)
             ▼
         { ok: true, action: 'speak', spoken: "…" }
```

Both halves run for every tool call. The iframe drives the visible avatar; the
endpoint returns the concise result the model reads back into the conversation.

### Tools

| Tool           | Arguments                                                                        | Effect                                  |
| -------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| `render_agent` | `{ agentId }`                                                                    | Bind / swap the avatar to an agent      |
| `speak`        | `{ text, sentiment? [-1,1] }`                                                    | Speak aloud with emotional valence      |
| `gesture`      | `{ name: wave\|nod\|point\|shrug, duration? }`                                   | Play a physical gesture                 |
| `emote`        | `{ trigger: concern\|celebration\|patience\|curiosity\|empathy, weight? [0,1] }` | Blend an emotion into the Empathy Layer |

The agent can also be set once via the plugin's `settings.agentId`, delivered to
the iframe in the init message — no `render_agent` call required.

---

## Submitting to the marketplace

The manifest is hosted and ready. To list it on `plugin.delivery`:

1. Confirm every URL resolves over HTTPS:
    - `https://three.ws/.well-known/sperax-plugin.json` (the manifest, CORS-enabled)
    - `https://three.ws/sperax/iframe/` (the panel)
    - `https://three.ws/api/chat-plugin/speak` and the three sibling tools
2. Open a **Plugin Submission** issue (or PR the manifest) at the
   `Sperax/AI-Plugin-Marketplace-SDK` repo, per its `docs/SUBMIT_PLUGIN.md`.
3. Tested in SperaxOS, no API key required (the only setting is a public Agent ID).

---

## Local testing

Drive the iframe with the protocol harness in `chat-plugin/dev/sperax.html` — it
posts the exact `speraxos:` / `lobe-chat:` messages a real host sends. Run the dev
server for the iframe, and a static server for the harness (it lives outside
`public/`, so Vite won't serve it):

```bash
npm run dev                  # http://localhost:3000  (iframe + /api)
python3 -m http.server 8080  # serves the harness
open "http://localhost:8080/chat-plugin/dev/sperax.html?origin=http://localhost:3000&agent=<agentId>"
```

---

## Chain note

SperaxOS is EVM-native and settles agent payments via x402 over USDC on Base
(`x402.sperax.io`), which matches three.ws's existing Base x402 rail. The avatar
panel itself is chain-agnostic — it renders and animates regardless of which chain
the bound agent transacts on. Solana-native actions are not driven by the host
wallet (SperaxOS injects no wallet provider); route any in-panel payment UX through
Base x402 or a self-contained flow.
