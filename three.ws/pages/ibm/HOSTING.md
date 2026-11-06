# Hosting the x402 live demo on `live.ibm.com`

`x402-demo.html` is a self-contained page that demonstrates the x402 micropayment
protocol: a visitor pays **$0.001 USDC** from their own wallet to call a real three.ws data
API, settled on-chain on Base or Solana. This guide is everything the IBM web team needs to
host it.

> **Reference deployment:** a byte-for-byte copy of this exact file runs at
> <https://three.ws/ibm/x402-demo>. Compare your hosted copy against it, or link to it
> directly if you'd rather not self-host.

## Editing the page after you've published it

The full partnership page (the webinar stage, the hero, the five demos) ships in two forms:

- **`hello.html`** — the **publish-once file** you upload (plus `fonts/`, `vendor/`, `three.svg`),
  exactly like `x402-demo.html`. It is **fully self-contained**: the complete page — markup,
  styles, and every demo — is baked in, so it renders and runs with **zero dependency on
  three.ws**. On load it *also* quietly fetches the latest version from
  `https://three.ws/ibm/hello.live` and, if reachable, swaps it in (and caches it for next time).
  This file is **generated** from `hello.live.html` — do not hand-edit it.
- **`hello.live.html`** — the **editable source**, served from three.ws at
  <https://three.ws/ibm/hello.live>. It holds all the copy, layout, and the webinar config (start
  time, video URL). Edit this.

**Why it's built this way:** some hosts let you publish a page once but then lock the path — you
can push, but you can't re-edit. That would freeze the content forever. So **every edit you make
to `hello.live.html` on three.ws appears on your hosted page automatically, with no re-publish** —
change the webinar start time, paste the recording URL, reword the hero, add a demo, and refresh
the hosted page. But three.ws is only an *enhancement*: if it's slow, down, or blocked, the
baked-in page runs instead. The visitor **never** sees a blank screen or a "couldn't load" card —
worst case they see the last published baseline rather than the very latest edit.

> Note: the **demos themselves** (the Forge/Play/IRL iframes, the x402 widget, the 3D agent)
> inherently call three.ws — that's what they are — so during a three.ws outage they degrade to
> their skeletons. What the self-contained baseline guarantees is that the **page** — its
> content, layout, and structure — always renders regardless.

To refresh the baked baseline that ships in `hello.html` (so offline visitors get newer content
too), regenerate and re-publish: `npm run build:ibm-shell` rebuilds `hello.html` from
`hello.live.html`. The Vercel deploy also runs this automatically, so the reference deployment's
baseline is always current; you only re-run it locally when you want a fresh file to hand off.

**CSP:** the page introduces **no new origins** — the live-update step only `fetch()`es and runs
scripts from `https://three.ws`, both already permitted by the policies below
(`connect-src https://three.ws`, `script-src … https://three.ws`). Because the partnership page
includes the 3D agent layer, host it under **Tier 2**. (SRI/`integrity` is intentionally not used
on the live fetch — pinning a hash would defeat letting the content change; the single trusted
origin, `three.ws`, is the security boundary, and the baked baseline is the integrity floor.)

> The same self-contained-plus-live-update pattern can be applied to `x402-demo.html` if you want
> that page editable post-publish too; everything below documents the standalone `x402-demo.html`
> artifact.

## What it demonstrates

The page is a **live showcase of the IBM × three.ws partnership** — five real, unmocked demos
presented in sequence, each running against production three.ws systems. The hero frames the
partnership and the lineup; everything below is interactive. The lineup leads with **Forge**
(Demo 01) because it needs no wallet — anyone can try it instantly — then moves to the x402
payment demo (Demo 02), the 3D agent (Demo 03), Play (Demo 04), and IRL (Demo 05).

**Demo 02 · x402 payments.** x402 reactivates the dormant HTTP `402 Payment Required` status as
a payment rail. A normal request to a paid endpoint returns `402` with machine-readable terms
(amount, asset, network, recipient). The visitor's wallet signs a gasless stablecoin
authorization, the request is retried with an `X-PAYMENT` header, and the call settles on-chain
in about a second — no API key, no account, no invoice. The page shows the live `402`
challenge, runs a real paid call, and renders the response plus the on-chain receipt.

## The 3D + agent layer (Demos 01, 03–05)

Beyond the payment demo the page embeds four more live three.ws surfaces, all loaded at runtime
from `https://three.ws` (still no build step, still no backend):

- **Demo 01 · Forge, and Demos 04–05 · Play / IRL** — each is its own full-size section
  (Creation, Worlds, Reality) with an explanation and the real `three.ws/forge`,
  `three.ws/play`, and `three.ws/irl` surface embedded full-width in an `<iframe>`. They
  lazy-load as each section nears the viewport (so the heavy apps never load at once), and each
  has a one-tap **Full screen** button plus a **new-tab** fallback. IRL is AR, so it's best on a
  phone and only prompts for the camera when the visitor chooses to enable it.
- **Demo 03 · A 3D AI agent** — the `<agent-3d>` web component renders a WebGL avatar that runs
  its own brain in the browser and **reacts to the payment**: it celebrates and announces the
  settlement the moment the visitor's `402` call clears. It lazy-boots only when scrolled into
  view, and degrades to a calm skeleton if its script is blocked.

Because these load the agent runtime, an avatar GLB, a WebGL/WASM context, `blob:` workers, and
framed three.ws pages, the 3D layer needs the more permissive **Tier 2** CSP below (each added
directive is explained in the table there). The Forge viewer's `<model-viewer>` is self-hosted
(see *What to upload*) so it stays a same-origin script. If you only want the x402 payment demo
and not the 3D/agent layer, delete the `#forge`, `#agent`, `#play`, and `#irl` `<section>`s plus
the `agent-3d.js` `<script>` tag, and the **Tier 1** policy is all you need.

## What to upload

Copy these to the same directory on the host (paths are relative, so they must stay together):

```
x402-demo.html
fonts/
  IBMPlexSans-300.woff2
  IBMPlexSans-400.woff2
  IBMPlexSans-500.woff2
  IBMPlexSans-600.woff2
  IBMPlexMono-400.woff2
  IBMPlexMono-500.woff2
vendor/
  model-viewer.min.js     (~0.9 MB; the 3D viewer, self-hosted so no Google CDN is needed)
```

Optional, **at the site root** (`live.ibm.com/three.svg`):

```
three.svg                 (the three.ws watermark the 3D agent overlays on snapshot exports)
```

The 3D agent fetches `/three.svg` from the origin root. If it's absent the agent still renders
perfectly — you'll just see one harmless `Failed to load watermark` console message and snapshot
exports won't carry the mark. Upload `three.svg` to the site root to remove that message. (On the
three.ws reference deployment this already resolves, so the message only appears on a foreign host
that hasn't placed the file.)

Everything else (the payment widget, the API, the explorer links) is loaded at runtime from
`https://three.ws` and the public chain explorers. There is **no build step** and **no
backend** to deploy. IBM Plex is self-hosted from `fonts/` so the page needs no third-party
font CDN, and the `<model-viewer>` web component (used by the Forge demo to display the
generated 3D model) is self-hosted from `vendor/` — it loads as a same-origin
(`script-src 'self'`) ES module, lazily and only after a model is forged, so no third-party
script CDN is required and a page view that never forges never pays its weight. Keep `vendor/`
next to the HTML; the file references it as `./vendor/model-viewer.min.js`.

## Content-Security-Policy

The page runs under **the host's CSP**. Pick one tier. (If `live.ibm.com` sends no CSP, the
page works as-is; these are for hardened hosts.) Both tiers below were verified in a real
Chromium, served from a non-three.ws origin with the CSP enforced as a response header — both
top-level and inside a cross-origin iframe — with **zero CSP violations** and no page errors.

### Tier 1 — Strict (Base / MetaMask only, recommended default)

The Base payment path signs entirely in-browser; its only network dependencies are the
three.ws widget and the three.ws API. Nothing loads from a third-party CDN.

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self' https://three.ws 'unsafe-inline';
  connect-src https://three.ws;
  style-src 'self' 'unsafe-inline';
  font-src 'self';
  img-src 'self' data:;
  base-uri 'self';
```

> `'unsafe-inline'` covers the page's inline `<style>` and the two small inline bootstrap
> `<script>` blocks. If IBM requires nonces, drop `'unsafe-inline'` and add a per-response
> nonce to the inline `<style>` and `<script>` tags instead.

Under this policy the Base button works fully; the Solana button fails gracefully — its `esm.sh`
dependency is blocked — with a clear message that steers the visitor to the Base path. The page
degrades, it never throws.

> Under Tier 1 the **3D agent layer** (the agent, and the Forge/Play/IRL rooms) is also
> blocked — it needs `frame-src`, `worker-src blob:`, `connect-src blob:`,
> `script-src 'wasm-unsafe-eval'`, and `https://esm.sh`, which Tier 1 omits. Use Tier 2 to
> enable it, or remove those sections (see above) to keep Tier 1.

### Tier 2 — Full (Base + Solana, plus the 3D agent layer)

This enables every demo. Each addition over Tier 1 is load-bearing — verified by removing it
and observing the resulting violation in a real browser:

| Directive | Why it's needed |
|-----------|-----------------|
| `script-src … https://esm.sh` | the Solana path dynamic-imports `@solana/web3.js` |
| `script-src … 'wasm-unsafe-eval'` | the agent/avatar instantiate a WebAssembly module |
| `connect-src 'self'` | the agent fetches its `/three.svg` watermark from the host origin |
| `connect-src … blob:` | the agent and model-viewer read geometry/textures via `blob:` URLs |
| `connect-src … https://esm.sh` | fetching the Solana library bundle |
| `img-src … blob: https://three.ws` | WebGL textures (`blob:`) and three.ws imagery |
| `worker-src 'self' blob:` | model-viewer and the agent spawn `blob:` workers |
| `frame-src https://three.ws` | the Forge / Play / IRL `<iframe>`s |

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self' https://three.ws https://esm.sh 'unsafe-inline' 'wasm-unsafe-eval';
  connect-src 'self' blob: https://three.ws https://esm.sh;
  style-src 'self' 'unsafe-inline';
  font-src 'self';
  img-src 'self' data: blob: https://three.ws;
  worker-src 'self' blob:;
  frame-src https://three.ws;
  base-uri 'self';
```

> The framed surfaces (`three.ws/play`, `three.ws/irl`, `three.ws/forge`) are separate
> documents governed by **three.ws's own** CSP — anything *they* load (chain RPCs, IPFS
> gateways, market data) is three.ws's concern, not the host page's. The host CSP only needs to
> permit framing them (`frame-src https://three.ws`). One known cross-origin item: the embedded
> `three.ws/irl` AR surface currently logs an internal `setMeshoptDecoder…` avatar message from
> inside its own iframe; it is three.ws app behavior, independent of the host page and unaffected
> by either CSP tier.

## Visitor requirements

- A browser wallet: **MetaMask** (Base) or **Phantom** (Solana).
- At least **$0.001 USDC on mainnet** in that wallet. The payment is a gasless signature; the
  network fee is sponsored by the x402 facilitator, so the visitor only spends the tenth of a
  cent.
- On mobile, wallets inject only inside their own in-app browser — the page tells visitors to
  open it there. Without a wallet, the page still shows the live `402` challenge (read-only).

## Top-level page vs. iframe

Host it as a **top-level page** for best results: browser wallet extensions inject reliably
into top-level documents, and the payment modal has full screen real estate. The page was
verified to load and run inside a **cross-origin iframe** as well — it sends no
`X-Frame-Options` and sets no restrictive `frame-ancestors`, so framing is not blocked, and the
demo (live 402 preview, widget, agent) renders in-frame. The one caveat is the wallet step:
**some browsers restrict wallet-extension injection into cross-origin iframes**, so the wallet
prompt may not appear in-frame in every browser. If you must iframe it, test the wallet flow in
your target browsers first, or link out to the standalone page.

A short console note: while reading the live payment challenge the demo intentionally
`fetch()`es endpoints that return HTTP `402`/`401`; browsers log every non-2xx fetch, so one or
two `responded with a status of 402` lines are expected — that is the protocol working, not a
fault. The page's own logic raises no errors under either CSP tier.

## Cross-origin (already handled)

three.ws serves the API and widget with `Access-Control-Allow-Origin: *` and exposes the x402
payment headers, so calls from `live.ibm.com` work cross-origin with no extra configuration on
either side.

## Telemetry & privacy

The page sends **no analytics, no tracking, and no error telemetry**. It carries no
third-party tag, no pixel, and no first-party beacon — nothing phones home about your
visitors. The only network traffic it generates is the documented set of three.ws calls (the
widget, the paid API, the agent runtime and demo embeds), the visitor's own wallet RPC, and
the public chain explorers they click through to. No wallet address, no payment detail, and no
personal data is ever collected by the page or forwarded to three.ws beyond what the x402
payment itself requires on-chain. This keeps the artifact clean for an enterprise security
review and lets it run under the strict Tier 1 CSP above without a single blocked request.

## Embed the pay button anywhere else

The whole flow is one drop-in script plus any element carrying a `data-x402-endpoint`. The
same eight lines that power the demo work standalone — drop them into a blog post, a docs
page, or a product page to add a working pay-per-call paywall with no framework, build step,
or SDK:

```html
<script type="module" src="https://three.ws/x402.js"></script>

<button
  data-x402-endpoint="https://three.ws/api/x402/symbol-availability?ticker=GRANITE"
  data-x402-merchant="three.ws"
  data-x402-action="Check symbol">
  Pay $0.001 & run
</button>
```

On click the script reads the endpoint's `402` challenge, opens the visitor's wallet for a
gasless USDC authorization, retries the call, and dispatches `x402:result` / `x402:error`
events with the response and on-chain receipt. Point `data-x402-endpoint` at any three.ws
x402 GET endpoint (browse them in the [Bazaar](https://three.ws/bazaar)) to charge for a
different call. The same Tier 1 / Tier 2 CSP guidance above applies to the host page.

## Note on branding

The page uses a neutral "IBM · Business Partner" wordmark lockup. Confirm the exact mark and
partnership wording against IBM brand guidelines before public launch.
