import { createWorldMesh } from '@worldmesh/runtime';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { buildVillage } from './world';

const scene = new Scene();
const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 350);
const renderer = new WebGLRenderer({ antialias: true });
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const colliders = buildVillage(scene);

// No abilities at all: this is the baseline every WorldMesh world starts from.
const world = createWorldMesh({
  scene,
  camera,
  renderer,
  spawn: [0, 2, 12],
  colliders,
  multiplayer: true,
  vr: true,
  view: { mode: 'third' },
  // Visitors arriving from the hub with a character picked in their Avatar
  // Wallet walk around as it; everyone else keeps the default body.
  avatar: {
    source: 'worldmesh',
    hubUrl: import.meta.env.VITE_WORLDMESH_HUB ?? (import.meta.env.DEV ? 'http://localhost:5170/' : 'https://worldmesh.net/'),
  },
  // Same overlay chrome as the lobby: no badge, no crosshair; WASD from the
  // first frame; Esc opens the pause menu.
  ui: {
    title: 'Medieval Village - Demo',
    badge: false,
    crosshair: false,
    deferLockPanel: true,
    moveBeforeLock: true,
  },
  // Portals disabled for now — URL-paste in the hub is the primary navigation.
  // portals: [
  //   { url: 'http://localhost:5175/', label: 'Space Station - Demo', position: [-8, 0, 4], color: 0xb08cff },
  //   { url: 'http://localhost:5173/', label: 'Neon City - Demo', position: [8, 0, 4], color: 0xff4fd8 },
  // ],
});

if (import.meta.env.DEV) {
  Object.assign(window, { world });
  import.meta.hot?.dispose(() => world.dispose());
}
