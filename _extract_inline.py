"""Throwaway: pull the final inline <script> out of index.html for node --check."""

import pathlib
import re

html = pathlib.Path("index.html").read_text(encoding="utf-8")
scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
print("inline scripts:", len(scripts))
pathlib.Path("_inline_check.js").write_text(scripts[-1], encoding="utf-8")
print("wrote _inline_check.js", len(scripts[-1]), "chars")
