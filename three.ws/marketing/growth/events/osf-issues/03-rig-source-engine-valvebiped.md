## Context

three.ws plays one shared animation library on any humanoid avatar by rewriting every bone name to one canonical skeleton. The map is [`src/glb-canonicalize.js`](https://github.com/nirholas/three.ws/blob/main/src/glb-canonicalize.js), and [Rig Doctor](https://three.ws/rig-doctor) ([`src/rig-report.js`](https://github.com/nirholas/three.ws/blob/main/src/rig-report.js)) names which convention an uploaded skeleton follows.

Characters from Valve's Source engine (and models exported from its tools) use a Biped-derived skeleton behind a `ValveBiped.` prefix: `ValveBiped.Bip01_Pelvis`, `ValveBiped.Bip01_L_UpperArm`, `ValveBiped.Bip01_Spine4`, `ValveBiped.Bip01_Neck1`, `ValveBiped.Bip01_Head1`. None of them map today, in either the raw glTF spelling or the spelling three.js produces at runtime (its `PropertyBinding.sanitizeNodeName` deletes the `.`, giving `ValveBipedBip01_Pelvis`). Rig Doctor also reports these rigs as unrecognised, because its `biped` fingerprint only matches names that start with `Bip`.

Verified on `main`:

```bash
node --input-type=module -e "
import { canonicalizeBoneName as c } from './src/glb-canonicalize.js';
for (const n of ['ValveBiped.Bip01_Pelvis', 'ValveBipedBip01_Pelvis', 'ValveBiped.Bip01_L_UpperArm', 'Bip01_L_UpperArm', 'Bip01_Spine4', 'Bip01_Neck1', 'Bip01_Head1']) console.log(n, '->', c(n));
"
```

```
ValveBiped.Bip01_Pelvis -> null
ValveBipedBip01_Pelvis -> null
ValveBiped.Bip01_L_UpperArm -> null
Bip01_L_UpperArm -> LeftArm
Bip01_Spine4 -> null
Bip01_Neck1 -> null
Bip01_Head1 -> null
```

The fourth line is the good news: once the `ValveBiped` prefix is gone, the existing 3ds Max Biped handling already maps the limbs. What is left is the prefix and the few joints Source numbers differently.

## What to change

1. In `_lookupBone` in `src/glb-canonicalize.js`, strip a leading `ValveBiped` prefix (with or without the `.`) before the existing `Bip<NN>` strip, with a comment naming the sanitizer case.
2. Map the Source-specific spellings: `Spine4` (the top of Source's four-joint spine; choose the canonical target and say why in the comment), `Neck1` to `Neck`, `Head1` to `Head`.
3. Add a `source` entry to `CONVENTIONS` in `src/rig-report.js` that matches joints starting with `ValveBiped.`, placed before the `biped` entry so it wins. Add its row to the conventions table in [`docs/rig-doctor.md`](https://github.com/nirholas/three.ws/blob/main/docs/rig-doctor.md).

Fingers are tracked in the separate Biped finger-chain issue; once that lands, Source fingers map through the same path with no extra work here.

## Acceptance criteria

- [ ] Pelvis, the spine chain, neck, head, clavicles, upper arms, forearms, hands, thighs, calves, and feet resolve for both `ValveBiped.Bip01_*` and `ValveBipedBip01_*`.
- [ ] No mapping crosses sides (test both `L` and `R`).
- [ ] Every existing Biped case still passes.
- [ ] `detectConvention` reports the new convention for a skeleton of `ValveBiped.` joints; a test in `tests/rig-report.test.js` proves it.
- [ ] The Rig Doctor doc table has the new row, and the drift test that compares supported conventions with documented ones passes.

## How to test

```bash
npx vitest run tests/glb-canonicalize.test.js tests/rig-report.test.js
npm test
```

Comment "taking this" before you start.
