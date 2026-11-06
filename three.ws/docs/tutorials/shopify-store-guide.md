# Add a 3D Store Guide to Your Shopify Store (No Code)

Give your store a **3D guide that walks across your pages** — it strolls from your hero to your bestsellers, spotlights each one, and narrates it out loud. Visitors can take the guided tour or grab the guide and free-roam. It runs on your live theme with **no app to install and no code to write**.

You'll build it by pointing and clicking in a live playground, watch it work, then paste three things into Shopify. Total time: about ten minutes.

> **Want to hand-tune every detail** — multi-page tours, exact section targeting, custom voices, your own avatar? That's the [Advanced store guide](/tutorials/shopify-store-guide-advanced). This page is the fast, no-code path.

---

## Step 1 — Design your guide in the Tour Builder

Open the **[Tour Builder](/tour-builder)**. It's a live playground — a demo storefront on the right, an editor on the left. Nothing you do here touches your real store until you're ready, and it works just like a website builder: point, click, type.

Make it yours:

1. **Choose the experience.** **🎬 Guided** — the avatar walks the store and narrates it by itself. **🕹 Explore** — your visitors drive the avatar with their arrow keys (or a joystick on mobile) and walk it into glowing checkpoints, GTA-style, to unlock each explanation. **🎮 Platformer** — Explore with gravity: your store's sections become solid ground and visitors run and jump between them (and can switch between Explore and Platformer live with the M key). Guided is effortless for shoppers; the interactive modes are playful and memorable. You can preview any of them.
2. **Pick your guide.** Choose who walks the store — Ava, Leo, a robot, and more.
3. **Add stops.** Each stop is one place the guide walks to (or, in Explore, a checkpoint the visitor walks it to) and one thing it says. Click **+ Add a stop**, then **click the section of the store** you want it to visit — the hero, a product grid, your reviews. The builder figures out how to point at it.
4. **Write the narration.** Type what the guide should say at each stop. Keep it short and friendly — one or two sentences, like a helpful shop assistant.
5. **Reorder** stops with the ↑ ↓ arrows, mark the best ones with ★ (those form a shorter "Quick tour" in Guided mode), and delete any you don't want.

Your work saves automatically in your browser as you go.

## Step 2 — Preview it

Hit **▶ Preview**. The editor slides away and the guide walks the demo store exactly the way your visitors will see it — spotlight, pointing, narration, playback controls, the works. Not happy? Press **Exit preview**, tweak, and preview again. This is the real product, so what you see is what your visitors get.

## Step 3 — Get the code

When it looks great, click **⬇ Get the code**. You'll get everything you need, generated from the tour you just built:

1. **A `curriculum.json` file** — your tour's script. Download it.
2. **A theme snippet** — one `<script>` tag.
3. **A button snippet** — the "Take the tour" button.

Keep that window open for the next step.

---

## Step 4 — Paste it into Shopify

Three copy-pastes in your Shopify admin. No theme knowledge required.

**4a. Upload your tour file.**
Go to **Content → Files** (in your Shopify admin sidebar). Click **Upload files** and choose the `curriculum.json` you downloaded. When it appears, click the **link/copy icon** next to it to copy its URL — it looks like `https://cdn.shopify.com/s/files/…/curriculum.json`. Keep that URL handy.

**4b. Add the guide to your theme.**
Go to **Online Store → Themes**. On your current theme, click **⋯ → Edit code**. In the file list on the left, open **`layout/theme.liquid`**. Scroll to the very bottom and find the `</body>` line. Paste the theme snippet from the builder **right before** `</body>`, and replace the `YOUR/PATH` part of the URL with the file URL you copied in 4a. Click **Save**.

**4c. Add the "Take the tour" button.**
Still in the theme editor, you can drop the button snippet anywhere you'd like visitors to start the tour. The easiest spot: back in the theme customizer (**Online Store → Themes → Customize**), add a **Custom Liquid** section to your homepage and paste the button snippet there. Save.

That's it. Open your store and click your new button — the guide walks out and gives the tour. 🎉

---

## Checking it works

- Open your storefront in a **normal browser tab** (not the theme editor's preview pane — that runs your store inside a frame, and the guide intentionally stays out of frames).
- Click your tour button. The guide should appear and start walking.
- Everything on your store still clicks normally while the tour runs — the guide floats above the page and never blocks a button or an Add-to-Cart.
- On phones it adapts automatically, and it respects a visitor's "reduce motion" setting.

**If it doesn't show up:**
- Double-check the `curriculum.json` URL in your theme snippet matches the one from **Content → Files** exactly.
- Make sure you pasted the script before `</body>`, not inside another tag.
- A handful of themes ship a strict security policy that blocks added scripts. If nothing loads at all, see the [Advanced guide's CSP section](/tutorials/shopify-store-guide-advanced#content-security-policy) — stock themes like Dawn need no changes.

---

## What's happening under the hood

The guide is a small, transparent 3D character that's positioned over your real page and walks to whatever section each stop names. It reads your page the way a visitor's eyes would — finding your headings and sections and measuring where they are — which is why it works on your live theme without rebuilding anything. It only ever appears on your storefront pages, never on checkout.

It's powered by the open-source [`@three-ws/tour`](https://www.npmjs.com/package/@three-ws/tour) package — the same engine behind the guided tour on [three.ws](https://three.ws).

## Where to go next

- **[Advanced store guide](/tutorials/shopify-store-guide-advanced)** — hand-write the curriculum, target exact sections, add multi-page tours, real spoken voices, your own avatar, autostart, deep links, and the JavaScript API.
- **[Add a talking assistant](/tutorials/embed-on-website)** — pair the guide with a chat agent trained on your store's FAQ and policies.
- **[Add the Walk Companion](/tutorials/walk-companion)** — a free-roaming 3D mascot for any page.
