import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// Shared City substrate — the renderer, scene (fog + lights + sky), and camera
// that both /city (src/city/city-world.js) and /agora (src/agora/agora-world.js)
// stand on. Extracted so the two worlds render an identical place: the same
// Manhattan lighting, sky, and tone mapping, built once here. Geometry (OSM
// buildings, roads) is layered on top by city-map.js's buildCity in each entry.

// Build the renderer, scene, and camera for a City-substrate world. The caller
// owns the OSM city geometry (buildCity), the camera controller, and the render
// loop — this only assembles the shared environment so both worlds match.
//
// @param {HTMLCanvasElement} canvas
// @returns {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, sun: THREE.DirectionalLight, sky: Sky }}
export function createCityScene(canvas) {
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type    = THREE.PCFShadowMap;
	renderer.toneMapping       = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.88;
	renderer.outputColorSpace  = THREE.SRGBColorSpace;

	const scene = new THREE.Scene();
	scene.fog = new THREE.Fog(0x9aafbf, 200, 900);

	const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 1200);
	camera.position.set(0, 14, 24);

	scene.add(new THREE.AmbientLight(0xc0d4e8, 1.5));

	const sun = new THREE.DirectionalLight(0xffe8c0, 2.2);
	sun.position.set(80, 100, -60);
	sun.castShadow = true;
	sun.shadow.mapSize.set(4096, 4096);
	sun.shadow.camera.near   = 1;
	sun.shadow.camera.far    = 1200;
	sun.shadow.camera.left   = -300;
	sun.shadow.camera.right  =  300;
	sun.shadow.camera.top    =  300;
	sun.shadow.camera.bottom = -300;
	sun.shadow.bias = -0.0006;
	scene.add(sun);

	const fill = new THREE.DirectionalLight(0x90b8e0, 0.75);
	fill.position.set(-80, 60, 80);
	scene.add(fill);

	scene.add(new THREE.HemisphereLight(0x92bada, 0x4a5e40, 0.65));

	const sky = new Sky();
	sky.scale.setScalar(8000);
	scene.add(sky);
	const su = sky.material.uniforms;
	su.turbidity.value       = 3.5;
	su.rayleigh.value        = 2.5;
	su.mieCoefficient.value  = 0.005;
	su.mieDirectionalG.value = 0.92;
	su.sunPosition.value.set(0.45, 0.38, -0.80).normalize();

	return { renderer, scene, camera, sun, sky };
}

// Keep the renderer + camera in sync with the viewport. Returns the bound
// handler so the caller can remove it on teardown.
export function bindResize(renderer, camera) {
	const onResize = () => {
		renderer.setSize(window.innerWidth, window.innerHeight);
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
	};
	window.addEventListener('resize', onResize);
	return onResize;
}
