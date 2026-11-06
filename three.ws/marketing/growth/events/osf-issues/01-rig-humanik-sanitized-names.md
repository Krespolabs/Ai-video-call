## Context

three.ws plays one shared animation library on any humanoid avatar by first rewriting every bone name to one canonical skeleton. The map lives in [`src/glb-canonicalize.js`](https://github.com/nirholas/three.ws/blob/main/src/glb-canonicalize.js), and the whole approach is explained in [docs/first-contribution.md](https://github.com/nirholas/three.ws/blob/main/docs/first-contribution.md).

Autodesk HumanIK / MotionBuilder rigs put every joint behind a character namespace: `Character1:Hips`, `Character1:LeftArm`. The raw glTF spelling already works, because `_lookupBone` strips a leading `identifier:` namespace, and `tests/glb-canonicalize.test.js` covers it.

The gap is the spelling the **runtime** sees. three.js's `GLTFLoader` passes every node name through `PropertyBinding.sanitizeNodeName`, which deletes `:` (along with `[`, `]`, `.`, `/`). So after loading, the same bone is named `Character1Hips`. The runtime retargeter in [`src/animation-retarget.js`](https://github.com/nirholas/three.ws/blob/main/src/animation-retarget.js) (`canonicalBoneEntries`) calls `canonicalizeBoneName(node.name)` on those loaded bones, and the fused name maps to nothing. Some exporters also write the underscore form `Character1_Hips`, which maps to nothing either.

Verified on `main`:

```bash
node --input-type=module -e "
import { canonicalizeBoneName as c } from './src/glb-canonicalize.js';
for (const n of ['Character1:Hips', 'Character1Hips', 'Character1LeftArm', 'Character1_Hips', 'Character1LeftHandIndex1']) console.log(n, '->', c(n));
"
```

```
Character1:Hips -> Hips
Character1Hips -> null
Character1LeftArm -> null
Character1_Hips -> null
Character1LeftHandIndex1 -> null
```

## What to change

In `_lookupBone` in `src/glb-canonicalize.js`, strip a leading HumanIK character prefix in its fused (`Character1Hips`) and underscore (`Character1_Hips`) forms, next to the existing vendor-prefix strips (`mixamorig`, `CH_`, `CC_Base_`, `Bip01`). Add a comment that says why the fused form exists (the three.js sanitizer), the same way the neighbouring strips explain themselves.

Require the digits (`Character` followed by one or more digits). A bare word like `CharacterMesh` must not be stripped.

## Acceptance criteria

- [ ] `Character1Hips`, `Character1Spine`, `Character1Neck`, `Character1Head`, and the left and right arm, forearm, hand, up-leg, leg, foot, and toe joints resolve to the same canonical names as their `Character1:` forms.
- [ ] The same holds for the underscore form (`Character1_LeftArm`) and for other character numbers (`Character2Hips`).
- [ ] Finger joints resolve too (`Character1LeftHandIndex1` to `LeftHandIndex1`, thumbs included), because fingers are most of every clip's tracks.
- [ ] Every existing `Character1:` case still passes, and no mapping crosses sides (test both sides).
- [ ] A name that only starts with `Character` without digits (`CharacterMesh`) still returns `null`.
- [ ] New cases live in `tests/glb-canonicalize.test.js`, in the file's `describe` + `it.each` table style, next to the existing HumanIK block.

## How to test

```bash
npx vitest run tests/glb-canonicalize.test.js
npm test
```

Re-run the probe above; every line should now print a canonical name.

Good first issue: one prefix rule, one comment, one test table. Comment "taking this" before you start.
