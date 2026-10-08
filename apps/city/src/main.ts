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
  // Preview builds set VITE_PRESENCE_ENDPOINT to their own relay (docs/previews.md).
  multiplayer: import.meta.env.VITE_PRESENCE_ENDPOINT ? { server: import.meta.env.VITE_PRESENCE_ENDPOINT } : true,
  vr: true,
  abilities: {
    doubleJump: true,
    dash: true,
    crouching: true,
  },
  ui: {
    // No click-to-enter panel: WASD works from the first frame, Esc brings up the menu.
    deferLockPanel: true,
    moveBeforeLock: true,
    title: 'Neon City - Demo',
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
  //   { url: 'http://localhost:5174/', label: 'Medieval Village - Demo', position: [-6, 0, -3], color: 0xffd36b },
  //   { url: 'http://localhost:5172/', label: 'Mars - Demo', position: [6, 0, -3], color: 0xff8a5c },
  // ],
});

if (import.meta.env.DEV) {
  Object.assign(window, { world });
  import.meta.hot?.dispose(() => world.dispose());
}
