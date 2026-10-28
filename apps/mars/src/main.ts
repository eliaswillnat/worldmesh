import { loadWorldMesh } from '@worldmesh/runtime';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { buildMars } from './world';

const scene = new Scene();
const camera = new PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.1, 500);
// alpha: the lobby shows through the way back to it (lobbyPortal) under the canvas.
const renderer = new WebGLRenderer({ antialias: true, alpha: true });
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const colliders = buildMars(scene);

const world = await loadWorldMesh({
  scene,
  camera,
  renderer,
  spawn: [0, 2, 10],
  colliders,
  vr: true,
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
    // No click-to-enter panel: WASD works from the first frame, Esc brings up the menu.
    deferLockPanel: true,
    moveBeforeLock: true,
    title: 'Mars - Demo',
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
  //   { url: 'http://localhost:5173/', label: 'Neon City - Demo', position: [-7, 0, -4], color: 0xff4fd8 },
  //   { url: 'http://localhost:5171/', label: 'Forest - Demo', position: [8, 0, 2], color: 0x8cff9e },
  // ],
}, {
  // Like any outside world, run the current runtime from worldmesh.net. Dev
  // and preview builds (VITE_WORLDMESH_RUNTIME=bundled) run this repo's own.
  hosted: !import.meta.env.DEV && import.meta.env.VITE_WORLDMESH_RUNTIME !== 'bundled',
});

if (import.meta.env.DEV) {
  Object.assign(window, { world });
  import.meta.hot?.dispose(() => world.dispose());
}
