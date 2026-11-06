import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

// Use 3d.png as the source — crop the cube portion to a square
const pngSource = join(publicDir, '3d.png');
const svgFallback = join(publicDir, 'pwa-icon.svg');

async function generateFromPng(sourcePath) {
	const img = sharp(sourcePath);
	const meta = await img.metadata();
	// Crop to a centered square from the right side where the cube lives
	const size = Math.min(meta.width, meta.height);
	const left = Math.max(0, Math.floor((meta.width - size) / 2));
	const top = 0;
	return sharp(sourcePath).extract({
		left: Math.floor(meta.width * 0.3),
		top: Math.floor(meta.height * 0.02),
		width: Math.floor(meta.height * 0.96),
		height: Math.floor(meta.height * 0.96),
	});
}

async function generateFromSvg(sourcePath) {
	return sharp(readFileSync(sourcePath));
}

const source = existsSync(pngSource) ? pngSource : svgFallback;
const pipeline =
	source === pngSource ? await generateFromPng(source) : await generateFromSvg(source);

for (const size of [192, 512]) {
	const outPath = join(publicDir, `pwa-${size}x${size}.png`);
	await pipeline.clone().resize(size, size).png().toFile(outPath);
	console.log(`Created ${outPath}`);
}
