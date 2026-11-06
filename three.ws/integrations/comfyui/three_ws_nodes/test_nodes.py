"""Smoke test for the ComfyUI nodes against a stub Forge server.

Validates that the nodes submit, poll, download, and cache — without ComfyUI,
torch, or a live network. The IMAGE path is exercised with a plain numpy array
(the node accepts anything array-like). Run:
    python -m unittest integrations/comfyui/three_ws_nodes/test_nodes.py
"""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

# Import the node module as part of its package so its relative import
# (`from .three_ws_client import ...`) resolves the same way ComfyUI loads it.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from three_ws_nodes import nodes  # noqa: E402


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        st = self.server.state
        p = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(p.query, keep_blank_values=True)
        if p.path == "/api/forge" and "job" in q:
            return self._send(200, {"job_id": q["job"][0], "status": "done", "glb_url": st["glb_url"]})
        if p.path == "/_glb":
            data = b"glb-bytes"
            self.send_response(200)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return self._send(404, {"error": "nf"})

    def do_POST(self):
        st = self.server.state
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        p = urllib.parse.urlparse(self.path)
        if p.path == "/api/forge-upload":
            host = f"http://127.0.0.1:{self.server.server_address[1]}"
            return self._send(200, {
                "upload_url": f"{host}/_put",
                "public_url": "https://cdn.example/y.png",
                "headers": {"content-type": "image/png"},
            })
        if p.path == "/api/forge":
            st["submits"] += 1
            return self._send(200, {"job_id": "j1", "status": "queued"})
        return self._send(404, {"error": "nf"})

    def do_PUT(self):
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()


class NodesTest(unittest.TestCase):
    def setUp(self):
        self.server = HTTPServer(("127.0.0.1", 0), _Handler)
        port = self.server.server_address[1]
        self.server.state = {"glb_url": f"http://127.0.0.1:{port}/_glb", "submits": 0}
        self.base = f"http://127.0.0.1:{port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_text_to_3d_node(self):
        node = nodes.ThreeWSTextTo3D()
        glb_path, status = node.generate(
            "a unique prompt for caching test 9921", "draft", "image", "auto", "1:1", api_url=self.base
        )
        self.assertTrue(os.path.isfile(glb_path))
        self.assertEqual(status, "done")
        with open(glb_path, "rb") as fh:
            self.assertEqual(fh.read(), b"glb-bytes")
        # Second identical call hits the on-disk cache, no new submit.
        before = self.server.state["submits"]
        _, status2 = node.generate(
            "a unique prompt for caching test 9921", "draft", "image", "auto", "1:1", api_url=self.base
        )
        self.assertEqual(status2, "cached")
        self.assertEqual(self.server.state["submits"], before)
        os.remove(glb_path)

    def test_image_to_3d_node(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy not available")
        img = np.zeros((1, 4, 4, 3), dtype="float32")
        node = nodes.ThreeWSImageTo3D()
        glb_path, status = node.generate(img, "draft", "image", "auto", prompt="", api_url=self.base)
        self.assertTrue(os.path.isfile(glb_path))
        self.assertEqual(status, "done")
        os.remove(glb_path)

    def test_node_mappings(self):
        self.assertIn("ThreeWSTextTo3D", nodes.NODE_CLASS_MAPPINGS)
        self.assertIn("ThreeWSImageTo3D", nodes.NODE_CLASS_MAPPINGS)
        self.assertEqual(nodes.NODE_DISPLAY_NAME_MAPPINGS["ThreeWSTextTo3D"], "three.ws Text→3D")


if __name__ == "__main__":
    unittest.main()
