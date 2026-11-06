"""Deterministic tests for the SMPL → three.js AnimationClip conversion.

No torch, no model, no GPU — pure-math validation of the bridge that the model
worker depends on. Run:  python -m unittest workers/model-text2motion/test_smpl_to_clip.py
"""

from __future__ import annotations

import math
import unittest

import numpy as np

from smpl_to_clip import (
    SMPL_TO_WOLF3D,
    axis_angle_to_quaternion,
    quat_multiply,
    smpl_motion_to_clip,
)


class AxisAngleTest(unittest.TestCase):
    def test_zero_is_identity(self):
        q = axis_angle_to_quaternion(np.zeros(3))
        np.testing.assert_allclose(q, [0, 0, 0, 1], atol=1e-9)

    def test_known_rotation(self):
        # 90° about +Y → quaternion (0, sin45, 0, cos45).
        q = axis_angle_to_quaternion(np.array([0.0, math.pi / 2, 0.0]))
        s = math.sin(math.pi / 4)
        np.testing.assert_allclose(q, [0, s, 0, s], atol=1e-9)

    def test_unit_norm(self):
        rng = np.random.default_rng(0)
        aa = rng.standard_normal((50, 3)) * 2.0
        q = axis_angle_to_quaternion(aa)
        norms = np.linalg.norm(q, axis=-1)
        np.testing.assert_allclose(norms, np.ones(50), atol=1e-9)

    def test_batched_shape(self):
        q = axis_angle_to_quaternion(np.zeros((4, 24, 3)))
        self.assertEqual(q.shape, (4, 24, 4))


class QuatMultiplyTest(unittest.TestCase):
    def test_identity(self):
        q = np.array([0.1, 0.2, 0.3, 0.9])
        q = q / np.linalg.norm(q)
        ident = np.array([0.0, 0.0, 0.0, 1.0])
        np.testing.assert_allclose(quat_multiply(ident, q), q, atol=1e-9)

    def test_compose_rotations(self):
        # Two 45° Y rotations compose to one 90° Y rotation.
        q45 = axis_angle_to_quaternion(np.array([0.0, math.pi / 4, 0.0]))
        q90 = axis_angle_to_quaternion(np.array([0.0, math.pi / 2, 0.0]))
        np.testing.assert_allclose(quat_multiply(q45, q45), q90, atol=1e-9)


class ClipConversionTest(unittest.TestCase):
    def _motion(self, frames=10, joints=24):
        rng = np.random.default_rng(42)
        poses = rng.standard_normal((frames, joints, 3)) * 0.3
        trans = np.cumsum(rng.standard_normal((frames, 3)) * 0.01, axis=0)
        return poses, trans

    def test_clip_shape_and_names(self):
        poses, trans = self._motion(frames=12)
        clip = smpl_motion_to_clip(poses, trans, fps=30, name="walk")
        self.assertEqual(clip["name"], "walk")
        self.assertAlmostEqual(clip["duration"], 11 / 30)
        self.assertEqual(clip["blendMode"], 2500)

        names = {t["name"] for t in clip["tracks"]}
        # One quaternion track per mapped bone, plus Hips.position.
        self.assertIn("Hips.quaternion", names)
        self.assertIn("Head.quaternion", names)
        self.assertIn("LeftForeArm.quaternion", names)
        self.assertIn("RightToeBase.quaternion", names)
        self.assertIn("Hips.position", names)
        quat_tracks = [t for t in clip["tracks"] if t["type"] == "quaternion"]
        self.assertEqual(len(quat_tracks), len(SMPL_TO_WOLF3D))

    def test_track_value_lengths(self):
        poses, trans = self._motion(frames=8)
        clip = smpl_motion_to_clip(poses, trans, fps=24)
        for t in clip["tracks"]:
            if t["type"] == "quaternion":
                self.assertEqual(len(t["values"]), 8 * 4)
            elif t["type"] == "vector":
                self.assertEqual(len(t["values"]), 8 * 3)
            self.assertEqual(len(t["times"]), 8)
            # Times are strictly increasing.
            self.assertTrue(all(t["times"][i] < t["times"][i + 1] for i in range(7)))

    def test_quaternions_are_unit(self):
        poses, trans = self._motion()
        clip = smpl_motion_to_clip(poses, trans)
        for t in clip["tracks"]:
            if t["type"] != "quaternion":
                continue
            v = np.array(t["values"]).reshape(-1, 4)
            np.testing.assert_allclose(np.linalg.norm(v, axis=1), 1.0, atol=1e-6)

    def test_no_translation_omits_position(self):
        poses, _ = self._motion()
        clip = smpl_motion_to_clip(poses, None)
        names = {t["name"] for t in clip["tracks"]}
        self.assertNotIn("Hips.position", names)

    def test_flattened_poses_accepted(self):
        poses, trans = self._motion(frames=5, joints=24)
        flat = poses.reshape(5, 72)
        clip = smpl_motion_to_clip(flat, trans, fps=30)
        self.assertTrue(any(t["name"] == "Hips.quaternion" for t in clip["tracks"]))

    def test_single_frame_is_static(self):
        poses = np.zeros((1, 24, 3))
        clip = smpl_motion_to_clip(poses, fps=30)
        self.assertEqual(clip["duration"], 0.0)
        self.assertEqual(len(clip["tracks"][0]["times"]), 1)

    def test_rest_offset_applied(self):
        # With a 90°-Y rest offset on Hips, the emitted Hips quaternion differs
        # from the raw SMPL one by exactly that premultiply.
        poses = np.zeros((1, 24, 3))  # all identity local rotations
        offset = axis_angle_to_quaternion(np.array([0.0, math.pi / 2, 0.0]))
        clip = smpl_motion_to_clip(poses, fps=30, rest_offsets={"Hips": offset.tolist()})
        hips = next(t for t in clip["tracks"] if t["name"] == "Hips.quaternion")
        np.testing.assert_allclose(np.array(hips["values"]), offset, atol=1e-9)

    def test_deterministic_uuid(self):
        poses, trans = self._motion()
        a = smpl_motion_to_clip(poses, trans, name="x")
        b = smpl_motion_to_clip(poses, trans, name="x")
        self.assertEqual(a["uuid"], b["uuid"])

    def test_rejects_bad_pose_shape(self):
        with self.assertRaises(ValueError):
            smpl_motion_to_clip(np.zeros((4, 5)), fps=30)  # 5 not divisible by 3

    def test_rejects_mismatched_trans(self):
        poses, _ = self._motion(frames=10)
        with self.assertRaises(ValueError):
            smpl_motion_to_clip(poses, np.zeros((9, 3)), fps=30)


if __name__ == "__main__":
    unittest.main()
