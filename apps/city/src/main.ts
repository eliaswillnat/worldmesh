import { createWorldMesh } from '@worldmesh/runtime';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { buildCity } from './world';

const scene = new Scene();
const camera = new PerspectiveCamera(76, window.innerWidth / window.innerHeight, 0.1, 400);
const renderer = new WebGLRenderer({ antialias: true });
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const colliders = buildCity(scene);

const world = createWorldMesh({
  scene,
  camera,
  renderer,
  spawn: [0, 2, 6],
  colliders,
  abilities: {
    doubleJump: true,
    dash: true,
    crouching: true,
  },
  ui: {
    title: 'Neon City',
    hubUrl: import.meta.env.VITE_WORLDMESH_HUB ?? 'http://localhost:5170/',
  },
  // Portals disabled for now — URL-paste in the hub is the primary navigation.
  // portals: [
  //   { url: 'http://localhost:5174/', label: 'Medieval Village', position: [-6, 0, -3], color: 0xffd36b },
  //   { url: 'http://localhost:5172/', label: 'Mars', position: [6, 0, -3], color: 0xff8a5c },
  // ],
});

if (import.meta.env.DEV) {
  Object.assign(window, { world });
  import.meta.hot?.dispose(() => world.dispose());
}
