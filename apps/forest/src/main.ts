import { createWorldMesh } from '@worldmesh/runtime';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { buildForest } from './world';

// --- An ordinary Three.js setup. Nothing WorldMesh-specific yet. -------------
const scene = new Scene();
const camera = new PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 400);
const renderer = new WebGLRenderer({ antialias: true });
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const colliders = buildForest(scene);

// --- This is the entire WorldMesh integration. ------------------------------
const world = createWorldMesh({
  scene,
  camera,
  renderer,
  spawn: [0, 2, 8],
  colliders,
  abilities: {
    doubleJump: true,
  },
  ui: {
    title: 'Forest',
    hubUrl: import.meta.env.VITE_WORLDMESH_HUB ?? 'http://localhost:5170/',
  },
  // Portals disabled for now — URL-paste in the hub is the primary navigation.
  // portals: [
  //   { url: 'http://localhost:5172/', label: 'Mars', position: [6, 0, -6], color: 0xff8a5c },
  //   { url: 'http://localhost:5175/', label: 'Space Station', position: [-4, 0, -12], color: 0xb08cff },
  // ],
});

if (import.meta.env.DEV) {
  // Handy while developing: inspect the player from the console.
  Object.assign(window, { world });
  import.meta.hot?.dispose(() => world.dispose());
}
