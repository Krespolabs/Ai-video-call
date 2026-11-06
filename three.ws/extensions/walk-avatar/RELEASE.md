# Chrome Web Store Release Checklist

Complete every item before each submission.

## Pre-build
- [ ] Version bumped in `package.json` (semver) — the prod build stamps it into `manifest.json`
- [ ] `data/changelog.json` entry written if this is a user-visible release
- [ ] Privacy policy at https://three.ws/extension/privacy is live and accurate (source: `PRIVACY.md`)
- [ ] Terms of service at https://three.ws/extension/terms is live and accurate (source: `TERMS.md`)
- [ ] `PERMISSIONS.md` matches the `permissions` + `host_permissions` in `manifest.json`

## Build
```bash
npm run build:extension:prod
```
- [ ] Build succeeds with zero errors
- [ ] `dist/extension-<version>.zip` created (version pulled from `package.json`)
- [ ] Output is minified, no `.map` source maps shipped in the zip
- [ ] Load `dist/extension/` via chrome://extensions → Load unpacked → confirm **no manifest errors and no warnings**

## Store listing assets
Regenerate with a source server running (`npm run dev`):
```bash
node scripts/extension-screenshots.mjs
```
Outputs to `extensions/walk-avatar/store-assets/`:
- [ ] `icon-128.png` — 128×128 store icon
- [ ] `promo-tile-440x280.png` — small promotional tile
- [ ] `marquee-1280x800.png` — marquee promotional image
- [ ] `screenshot-1.png` — avatar walking on a real content/article page (1280×800)
- [ ] `screenshot-2.png` — popup with the avatar selection grid (1280×800)
- [ ] `screenshot-3.png` — settings page (1280×800)
- [ ] `screenshot-4.png` — avatar narrating with its speech bubble (1280×800)
- [ ] `screenshot-5.png` — avatar on a real social page (1280×800)

All screenshots are captured from the real product (real Chromium, real `/walk-embed`
render, real public three.ws avatars). No mockups.

## Functional QA
- [ ] Popup opens and renders correctly
- [ ] Sign-in flow works (opens three.ws/login)
- [ ] "My Avatars" loads from real API after sign-in
- [ ] "Featured" loads real public avatars without sign-in
- [ ] Selecting an avatar updates the walking iframe on the current tab
- [ ] Enable toggle injects the avatar on the current tab
- [ ] Disable toggle removes the avatar cleanly
- [ ] Avatar persists through SPA navigation (test on a social site)
- [ ] Drag handle repositions the avatar; close button hides it on the page
- [ ] Settings page saves and syncs settings
- [ ] Allowlist/blocklist filtering works
- [ ] Narration reads sections aloud and shows the speech bubble (if narration enabled)
- [ ] Speed slider live-updates walk speed

## Submission
1. `npm run build:extension:prod`
2. Upload `dist/extension-<version>.zip` to the Chrome Web Store Developer Dashboard
3. Fill in the listing: short description (≤132 chars) + detailed description
4. Upload all assets from `store-assets/`
5. Set privacy policy URL: https://three.ws/extension/privacy
6. Paste the per-permission justifications from `PERMISSIONS.md`
7. Submit for review (typically 1–3 business days)

---

## Program-policy self-review

Reviewed against https://developer.chrome.com/docs/webstore/program-policies/.
Re-confirm each line before every submission; current status reflects the
1.0.0 package.

### Single purpose
- [x] **One clear purpose** — display a 3D three.ws avatar on web pages and,
  optionally, narrate page sections. All features serve this single purpose.

### Permissions & user data
- [x] **Minimum permissions** — `storage`, `activeTab`, `tabs`, `scripting`,
  and `host_permissions` are each justified in `PERMISSIONS.md`. No
  `webRequest`, `cookies`, `history`, `downloads`, `clipboard`, or other broad
  permissions are requested.
- [x] **`<all_urls>` justified** — the user may enable the avatar on any site
  they choose; the content script is injected **only on explicit user action**
  (the popup toggle), never automatically on every page.
- [x] **Limited-use compliance** — page content never leaves the browser except
  the visible section's text sent to `/api/tts/speak`, and only when the user
  turns narration on (off by default). No data is sold, transferred, or used
  for advertising or creditworthiness.
- [x] **Privacy disclosure** — `PRIVACY.md` / the live privacy page list every
  stored field and every network request. Only three.ws is contacted.

### Deceptive & malicious behavior
- [x] **No deceptive behavior** — no hidden functionality, no cloaking, no
  affiliate/redirect injection, no surprise installs.
- [x] **No malware / unwanted software** — no obfuscation; all logic is in the
  reviewable bundle. No remote-config that changes behavior post-review.

### Code & content security
- [x] **No remotely hosted code** — all JS is bundled locally by esbuild. The
  only remote resource is the sandboxed `https://three.ws/walk-embed` iframe
  (rendered content, not executed extension code) and avatar GLB/thumbnail
  assets.
- [x] **CSP enforced** — `extension_pages` CSP is `script-src 'self'; object-src
  'self'`. No inline scripts, no `eval`, no `unsafe-inline` in extension pages.
- [x] **No inline event handlers** — popup/options wire listeners in JS, not via
  `onclick=` attributes.

### Listing quality
- [x] **Accurate metadata** — `description` is ≤132 chars and matches behavior.
- [x] **Real screenshots** — all five are captures of the actual running product.
- [x] **Functional on install** — featured avatars load without an account; the
  avatar renders from `/walk-embed` with no extra setup.

### Blocked content
- [x] **No prohibited content** — no adult, violent, hateful, or deceptive
  content; avatars are user/creator content governed by the three.ws license.
