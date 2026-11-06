# OpenAI Plugin Directory: every field, paste-ready

Each block is under the portal's silent limit. Do not edit them longer without re-running this script.

## MCP tab: tool justifications

### forge_free

**Read Only**  (101/200)
```
Runs a 3D generation and writes a new GLB file into our object storage, then returns that file's URL.
```

**Open World**  (136/200)
```
Publishes the generated GLB at a public URL anyone with the link can fetch, and relies on third-party inference providers to produce it.
```

**Destructive**  (117/200)
```
Only adds a new file and never overwrites or deletes an existing one, so a model supplied as input is left unchanged.
```

### text_to_avatar

**Read Only**  (101/200)
```
Runs a 3D generation and writes a new GLB file into our object storage, then returns that file's URL.
```

**Open World**  (136/200)
```
Publishes the generated GLB at a public URL anyone with the link can fetch, and relies on third-party inference providers to produce it.
```

**Destructive**  (117/200)
```
Only adds a new file and never overwrites or deletes an existing one, so a model supplied as input is left unchanged.
```

### mesh_forge

**Read Only**  (101/200)
```
Runs a 3D generation and writes a new GLB file into our object storage, then returns that file's URL.
```

**Open World**  (136/200)
```
Publishes the generated GLB at a public URL anyone with the link can fetch, and relies on third-party inference providers to produce it.
```

**Destructive**  (117/200)
```
Only adds a new file and never overwrites or deletes an existing one, so a model supplied as input is left unchanged.
```

### rig_mesh

**Read Only**  (101/200)
```
Runs a 3D generation and writes a new GLB file into our object storage, then returns that file's URL.
```

**Open World**  (136/200)
```
Publishes the generated GLB at a public URL anyone with the link can fetch, and relies on third-party inference providers to produce it.
```

**Destructive**  (117/200)
```
Only adds a new file and never overwrites or deletes an existing one, so a model supplied as input is left unchanged.
```

### forge_avatar

**Read Only**  (101/200)
```
Runs a 3D generation and writes a new GLB file into our object storage, then returns that file's URL.
```

**Open World**  (136/200)
```
Publishes the generated GLB at a public URL anyone with the link can fetch, and relies on third-party inference providers to produce it.
```

**Destructive**  (117/200)
```
Only adds a new file and never overwrites or deletes an existing one, so a model supplied as input is left unchanged.
```

### refine_model

**Read Only**  (101/200)
```
Runs a 3D generation and writes a new GLB file into our object storage, then returns that file's URL.
```

**Open World**  (136/200)
```
Publishes the generated GLB at a public URL anyone with the link can fetch, and relies on third-party inference providers to produce it.
```

**Destructive**  (117/200)
```
Only adds a new file and never overwrites or deletes an existing one, so a model supplied as input is left unchanged.
```

### check_job

**Read Only**  (144/200)
```
The first check that finds a job finished copies the model into our storage and records the creation, so the call writes rather than only reads.
```

**Open World**  (129/200)
```
Collects work from third-party inference providers and publishes the finished GLB at a public URL anyone with the link can fetch.
```

**Destructive**  ( 76/200)
```
Only adds the finished model and never deletes or overwrites an earlier one.
```

### look_at_model

**Read Only**  (127/200)
```
Renders a model that already exists from several angles and returns the frames as images, storing nothing and changing nothing.
```

**Open World**  ( 92/200)
```
Fetches an arbitrary public GLB URL, so it reaches third-party hosts outside our own domain.
```

**Destructive**  ( 99/200)
```
Only reads the supplied model in order to render it, and never modifies or deletes the source file.
```

## Testing tab: test cases

### Test Case 1

**Scenario**
```
Generate a 3D prop from a text description
```

**User prompt**
```
Make a 3D model of a friendly round robot mascot, glossy white plastic.
```

**Tool triggered**
```
forge_free; if it returns status "pending", the viewer widget collects the model with check_job
```

**Expected output**  (282/300)
```
An inline 3D viewer showing the textured robot, auto-rotating until dragged, with Download GLB, Open viewer and View in your space. Free, no account. The call answers within about 40s; if still rendering, the viewer shows a live timer and fills in by itself, usually in 1-4 minutes.
```

### Test Case 2

**Scenario**
```
Generate a rigged, animation-ready character
```

**User prompt**
```
Make a rigged, animation-ready knight character I can pose.
```

**Tool triggered**
```
forge_avatar; if it returns status "pending", the viewer widget collects the mesh with check_job and rigs it with rig_mesh
```

**Expected output**  (250/300)
```
The knight in the inline viewer, labeled rigged model, carrying a humanoid skeleton and skin weights so it can be posed. If the call answers before the mesh is done, the viewer finishes the mesh, runs the rig step itself, then shows the rigged model.
```

### Test Case 3

**Scenario**
```
Iterate on a model by describing the change in words
```

**User prompt**
```
Now make that robot's shell matte instead of glossy.
```

**Tool triggered**
```
refine_model; if it returns status "pending", the viewer widget collects it with check_job
```

**Expected output**  (266/300)
```
Run right after test case 1 in the same conversation. A new version anchored to the robot, not an unrelated model, appears in the viewer with a Versions strip (Original, then the change) so either version can be shown again. A still-rendering one fills in by itself.
```

### Test Case 4

**Scenario**
```
Let the assistant see a 3D model and report on it
```

**User prompt**
```
Look at this 3D model and tell me what it is and whether it has any obvious defects: https://three.ws/cdn/objects/polyhaven/glb/ArmChair_01.glb
```

**Tool triggered**
```
look_at_model
```

**Expected output**  (243/300)
```
Frames from four angles returned as image content, plus geometry stats, and the armchair in the inline viewer. The assistant describes the chair from images it can actually see. Free, about 30 seconds. The URL is ours and needs no credentials.
```

### Test Case 5

**Scenario**
```
Generate a model through the art-directed lane
```

**User prompt**
```
Use the art-directed generator to make a detailed vintage brass telescope on a wooden tripod.
```

**Tool triggered**
```
mesh_forge; if it returns status "pending", the viewer widget collects the model with check_job
```

**Expected output**  (265/300)
```
A textured telescope in the same inline viewer, with Download GLB and Open viewer. An art-direction pass may first tighten the prompt into a single-subject spec. Free, no account. If still rendering after about 40s, the viewer shows progress and fills in by itself.
```

## Testing tab: negative cases

### Negative Test Case 1

**Scenario**  (178/200)
```
The user wants a 2D image, not a 3D model. The wording nearly matches our main generation prompt, but this plugin only returns 3D GLB files, so image generation should handle it.
```

**User prompt**
```
Draw a cartoon robot mascot for my startup's landing page.
```

### Negative Test Case 2

**Scenario**  (145/200)
```
"Model" is a verb here, meaning a financial projection. Nothing 3D is involved, and no tool in this plugin operates on spreadsheets or forecasts.
```

**User prompt**
```
Model out our Q3 revenue if we raise prices 20%.
```

### Negative Test Case 3

**Scenario**  (194/200)
```
The user asks how to do something in other software, not for work on a file. It says "rig" and "character", but rig_mesh needs the URL of an existing GLB and would return nothing they asked for.
```

**User prompt**
```
How do I rig a humanoid character in Blender?
```

