## Context

three.ws plays one shared animation library on any humanoid avatar by rewriting every bone name to one canonical skeleton first. The map is [`src/glb-canonicalize.js`](https://github.com/nirholas/three.ws/blob/main/src/glb-canonicalize.js); [docs/first-contribution.md](https://github.com/nirholas/three.ws/blob/main/docs/first-contribution.md) walks through how a convention is added.

3ds Max Biped rigs already map for the body: `_lookupBone` strips the `Bip01` / `Bip001` prefix, so `Bip01 L UpperArm` becomes `LeftArm`. **The fingers do not map.** Biped numbers its fingers instead of naming them:

| Biped name | Finger | Segment | Canonical |
|---|---|---|---|
| `Bip01 L Finger0` | thumb | 1 | `LeftHandThumb1` |
| `Bip01 L Finger01` | thumb | 2 | `LeftHandThumb2` |
| `Bip01 L Finger02` | thumb | 3 | `LeftHandThumb3` |
| `Bip01 L Finger1` | index | 1 | `LeftHandIndex1` |
| `Bip01 L Finger11` | index | 2 | `LeftHandIndex2` |
| `Bip01 L Finger2` / `21` / `22` | middle | 1 / 2 / 3 | `LeftHandMiddle1` / `2` / `3` |
| `Bip01 L Finger3` / `31` / `32` | ring | 1 / 2 / 3 | `LeftHandRing1` / `2` / `3` |
| `Bip01 L Finger4` / `41` / `42` | pinky | 1 / 2 / 3 | `LeftHandPinky1` / `2` / `3` |

The rule is unambiguous: one digit is the finger at segment 1; two digits are the finger and then the segment minus one.

This matters more than it looks. Most of the tracks in every clip address a finger joint, so a rig whose hands do not map scores low on retarget coverage (the MMD section of the onboarding doc explains the number).

Verified on `main`:

```bash
node --input-type=module -e "
import { canonicalizeBoneName as c } from './src/glb-canonicalize.js';
for (const n of ['Bip01 L UpperArm', 'Bip01 L Finger0', 'Bip01 L Finger01', 'Bip01_L_Finger1', 'Bip001 R Finger42', 'Bip01_L_Toe0']) console.log(n, '->', c(n));
"
```

```
Bip01 L UpperArm -> LeftArm
Bip01 L Finger0 -> null
Bip01 L Finger01 -> null
Bip01_L_Finger1 -> null
Bip001 R Finger42 -> null
Bip01_L_Toe0 -> null
```

## What to change

Add the Biped finger chain (and `Toe0` to `LeftToeBase` / `RightToeBase`) to `src/glb-canonicalize.js`. After the `Bip` prefix strip, a Biped finger reaches the lookup as a key like `lfinger01`; the `EXTRA_ALIASES` block and its `put()` helper are the natural home, generated in a loop the way the MikuMikuDance finger chains are. Say in a comment how the numbering works.

## Acceptance criteria

- [ ] All 15 finger joints per hand map as in the table, for both `Bip01` and `Bip001`, and for the space (`Bip01 L Finger0`) and underscore (`Bip01_L_Finger0`) spellings. The underscore spelling is what three.js hands the runtime after sanitizing names.
- [ ] `Bip01 L Toe0` and `Bip01 R Toe0` map to `LeftToeBase` and `RightToeBase`.
- [ ] No mapping crosses sides: every `L` name maps to a `Left*` bone and every `R` name to a `Right*` bone.
- [ ] Existing Biped body cases still pass.
- [ ] Tests in `tests/glb-canonicalize.test.js`, in the file's `describe` + `it.each` style.

## How to test

```bash
npx vitest run tests/glb-canonicalize.test.js
npm test
```

Good first issue: the whole change is a loop and a test table. Comment "taking this" before you start.
