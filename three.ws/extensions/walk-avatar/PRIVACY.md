# Privacy Policy — three.ws Walk Avatar

_Last updated 2026-05-25 · Live copy: https://three.ws/extension/privacy_

The three.ws Walk Avatar extension is built to keep your data on your device.
This policy describes exactly what the extension stores, what it sends over the
network, and what it never collects.

## What we collect

The extension stores the following on your device via `chrome.storage`:

- **Avatar selection** — the ID of the avatar you chose to display.
- **Settings** — walk speed, on-screen position, size, the per-site
  allowlist/blocklist, narration on/off, and the selected narration voice.
  These sync across your signed-in Chrome installs via `chrome.storage.sync`.
- **Session token** — if you sign in to three.ws, an authentication token is
  stored in `chrome.storage.local` (this device only — never synced).
- **Recent picks** — the avatars you have selected in the popup, kept locally so
  you can switch back quickly.

## What we do not collect

- We do **not** collect or store the content of pages you visit.
- We do **not** track your browsing history.
- We do **not** sell or share any data with third parties.
- We do **not** include analytics or tracking pixels in the extension.

## Network requests

The extension contacts **three.ws only**. There are no third-party endpoints.

- `GET https://three.ws/api/avatars/*` — fetches your avatar list and the GLB
  model URLs when you open the popup or settings.
- `https://three.ws/walk-embed` — the iframe that renders the 3D avatar on the
  page. The avatar GLB is streamed from three.ws.
- `POST https://three.ws/api/tts/speak` — **only** when you explicitly enable
  "Read page sections aloud." The text of the section currently in view is sent
  to generate audio. This feature is **off by default**.
- `GET https://three.ws/api/me` — verifies your session (only when signed in).

No page content leaves your browser unless you turn on narration, and even then
only the visible section text is sent — never the full page, never in the
background.

## Permissions

Each Chrome permission and why it is required is documented in
[`PERMISSIONS.md`](./PERMISSIONS.md).

## Data retention & deletion

All extension data lives on your device. Clear it any time by signing out in the
extension settings, clearing the site data, or removing the extension from
Chrome. Removing the extension deletes all locally stored data.

## Contact

Questions about privacy: [privacy@three.ws](mailto:privacy@three.ws) ·
[three.ws](https://three.ws)
