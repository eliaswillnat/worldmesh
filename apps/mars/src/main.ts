import { createWorldMesh } from '@worldmesh/runtime';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { buildMars } from './world';

const scene = new Scene();
const camera = new PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.1, 500);
const renderer = new WebGLRenderer({ antialias: true });
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const colliders = buildMars(scene);

const world = createWorldMesh({
  scene,
  camera,
  renderer,
  spawn: [0, 2, 10],
  colliders,
  abilities: {
    doubleJump: true,
    dash: true,
  },
  // Same controller, different planet: gravity is tuning, not a fork.
  movement: {
    gravity: 8.6,
    jumpSpeed: 6.4,
    airAccel: 6,
  },
  ui: {
    title: 'Mars',
    hubUrl: import.meta.env.VITE_WORLDMESH_HUB ?? 'http://localhost:5170/',
  },
  // Portals disabled for now — URL-paste in the hub is the primary navigation.
  // portals: [
  //   { url: 'http://localhost:5173/', label: 'Neon City', position: [-7, 0, -4], color: 0xff4fd8 },
  //   { url: 'http://localhost:5171/', label: 'Forest', position: [8, 0, 2], color: 0x8cff9e },
  // ],
});

if (import.meta.env.DEV) {
  Object.assign(window, { world });
  import.meta.hot?.dispose(() => world.dispose());
}
