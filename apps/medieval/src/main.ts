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
  view: { mode: 'third' },
  ui: {
    // No click-to-enter panel: WASD works from the first frame, Esc brings up the menu.
    deferLockPanel: true,
    moveBeforeLock: true,
    title: 'Medieval Village - Demo',
    badge: false,
    hubUrl:
      import.meta.env.VITE_WORLDMESH_HUB ??
      (import.meta.env.DEV
        ? 'http://localhost:5170/'
        : import.meta.env.VITE_WORLDS_BASE_DOMAIN
          ? `https://${import.meta.env.VITE_WORLDS_BASE_DOMAIN}/`
          : 'https://worldmesh-hub.pages.dev/'),
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
