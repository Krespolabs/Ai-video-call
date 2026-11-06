# Submitting the three.ws extension to Blender Extensions

The add-on in [`three_ws/`](three_ws/) is packaged as a Blender extension and
follows the [extension getting-started guide](https://docs.blender.org/manual/en/latest/advanced/extensions/getting_started.html)
and the [add-on guidelines](https://developer.blender.org/docs/handbook/extensions/addon_guidelines/).

| Manifest field | Value |
|---|---|
| `id` | `three_ws` (confirmed unused on extensions.blender.org, 2026-09-17) |
| `name` | `three.ws Forge` |
| `version` | `1.0.0` |
| `tagline` | `Generate 3D models from text or images with three.ws Forge` (58 chars) |
| `type` | `add-on` |
| `blender_version_min` | `4.2.0` |
| `license` | `SPDX:GPL-3.0-or-later` (full text in `three_ws/LICENSE`) |
| `tags` | `Import-Export`, `Add Mesh` |
| `permissions` | `network`, `files`, each with a reason under 64 chars |

## Compliance checklist

- **Online access:** every network path (the Generate and Test connection
  operators) checks `bpy.app.online_access` in `poll()` and again in
  `execute()`, and refuses with a message that distinguishes the preference
  from a `--offline-mode` launch. The panel shows the reason and an Open
  Preferences shortcut.
- **Namespace:** preferences use `bl_idname = __package__` and are read through
  `context.preferences.addons[__package__]`; the client is imported relatively.
- **No `bl_info`:** the manifest replaces it. Blender 4.2 is the minimum, so
  there is no legacy install path to keep.
- **Self-contained:** stdlib only, no wheels, no pip, no `sys.path` changes.
- **Read-only install safe:** nothing is written into the add-on directory; the
  downloaded GLB goes to the system temp directory and is deleted after import.
- **License:** GPL-3.0-or-later, as the platform requires for add-ons.

## What was already validated (Blender 4.2.9 LTS, Linux)

- `blender --command extension validate` passes on the source folder and on the
  built zip.
- `blender --command extension build` produces `three_ws-1.0.0.zip` containing
  only `blender_manifest.toml`, `__init__.py`, `three_ws_client.py`, `LICENSE`.
- The zip installs with `extension install-file` and enables as
  `bl_ext.user_default.three_ws`.
- `--offline-mode`: both operators' `poll()` return False with the command-line
  message and a direct call is refused. Preference off (factory settings): same,
  with the "Allow Online Access" message.
- `--online-mode`: **Test connection** reached https://three.ws and listed the
  live backends, and a real draft text-to-3D generation downloaded a 2 MB GLB
  that `import_scene.gltf` loaded into the scene.
- Not exercised: the sidebar panel drawing and the modal Generate operator, which
  need an interactive window. Check them in step 2 below.

## Owner steps

1. **Blender ID.** Sign in at <https://extensions.blender.org> with the Blender
   ID that should own the listing (create one at <https://id.blender.org> if
   needed).
2. **Build and smoke test locally** on a clean checkout of `main`:

   ```bash
   cd integrations/blender/three_ws
   blender --command extension validate
   blender --command extension build --output-dir /tmp
   ```

   In Blender (4.2 or newer): **Edit > Preferences > Get Extensions > Install
   from Disk...**, pick `/tmp/three_ws-1.0.0.zip`, open the 3D Viewport sidebar
   (N) > **three.ws**, click **Test connection**, then generate one model from a
   short text prompt. Turn **Preferences > System > Network > Allow Online
   Access** off and confirm the panel shows the warning and the buttons grey out.
3. **Upload.** Go to <https://extensions.blender.org/submit/>, upload
   `/tmp/three_ws-1.0.0.zip`, and accept the terms.
4. **Complete the listing** on the draft page: a description (reuse the Use and
   Online access sections of `README.md`), at least one screenshot of the
   sidebar panel with an imported model, and an optional icon. The support link
   is `https://github.com/nirholas/three.ws/issues`.
5. **Submit for review.** The listing enters the approval queue
   (<https://extensions.blender.org/approval-queue/>). Reply to moderator
   comments on that page; any code change means bumping `version` in the
   manifest, rebuilding, and uploading the new zip as a new version.
6. Delete the local zip; build archives are never committed.

## Post-publish verification

1. <https://extensions.blender.org/add-ons/three-ws/> is public and shows
   version 1.0.0, GPL-3.0-or-later, and the network and files permissions.
2. `curl -s https://extensions.blender.org/api/v1/extensions/ | grep -o '"id": *"three_ws"'`
   finds the listing in the platform index Blender reads.
3. In a fresh Blender profile: **Get Extensions**, allow online access, search
   `three.ws Forge`, install, and confirm it enables without errors in the
   console.
4. Generate a model from text with the default image pipeline. The imported,
   selected object is the "first completed generation" evidence for the
   Blender Extensions row in `marketing/growth/opportunities.csv`; set that row
   to `live` with the listing URL.
