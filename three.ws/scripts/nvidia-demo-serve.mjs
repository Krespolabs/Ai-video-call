#!/usr/bin/env node
// Tiny static server for the NVIDIA demo viewer. Serves the viewer HTML and the
// generated GLBs over http so the GLTFLoader fetch works (file:// won't).
//
//   node scripts/nvidia-demo-serve.mjs
//   → http://localhost:4545/?model=/demo/<slug>.glb&prompt=your%20prompt
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';

const PORT = process.env.PORT || 4545;
const ROOT = process.cwd();
const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.glb': 'model/gltf-binary',
	'.gltf': 'model/gltf+json',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.json': 'application/json',
};

createServer(async (req, res) => {
	try {
		let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		if (path === '/' || path === '') path = '/scripts/nvidia-demo-viewer.html';
		const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
		if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
		const body = await readFile(full);
		res.writeHead(200, {
			'content-type': TYPES[extname(full)] || 'application/octet-stream',
			'access-control-allow-origin': '*',
			'cache-control': 'no-store',
		}).end(body);
	} catch {
		res.writeHead(404).end('not found');
	}
}).listen(PORT, () => {
	console.log(`Demo viewer → http://localhost:${PORT}/?model=/demo/<slug>.glb`);
});
