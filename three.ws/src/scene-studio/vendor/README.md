# Vendored three.js editor

Source: [mrdoob/three.js](https://github.com/mrdoob/three.js) tag `r184`, `editor/`
directory. MIT — see [LICENSE](LICENSE). Version must track the `three` dependency
in the root `package.json`; re-vendor from the matching tag when upgrading three.

## Layout

- `js/`, `css/` — upstream editor source (ES modules), bundled by Vite via
  `src/scene-studio/main.js`.
- Classic-script libs (CodeMirror, tern, acorn, esprima, jsonlint, signals) were
  moved out of `js/libs/` to `public/scene-studio/libs/` and load as plain
  `<script>` tags in `pages/scene.html`, exactly as upstream's `index.html` does.
- Static runtime assets live under `public/scene-studio/`: `draco/` + `basis/`
  (copied from `node_modules/three/examples/jsm/libs/`), `images/` (toolbar
  icons), `fonts/` (helvetiker for the Add → Text menu), `app/` (publish-zip
  template; `app/app.js` is a copy of `js/libs/app.js` — keep them in sync).

## Local modifications (re-apply when re-vendoring)

- `Toolbar.js` — icon paths → `/scene-studio/images/`.
- `Loader.js` — draco/basis decoder paths → `/scene-studio/…`; rhino3dm and the
  LDraw parts library → version-pinned jsDelivr URLs (too large to commit).
- `Menubar.Add.js` — helvetiker font → `/scene-studio/fonts/`.
- `Sidebar.Project.App.js` — publish template paths → `/scene-studio/app/…`;
  three builds for the publish zip fetch from jsDelivr pinned to
  `THREE.REVISION`; the published EDIT button links to three.ws/scene.
- `index.html` upstream boot lives in `../main.js` (container mount under the
  site nav instead of `document.body`; no service worker).
- three.ws chrome overrides live in `../studio.css` — vendor `css/main.css` is
  untouched.
