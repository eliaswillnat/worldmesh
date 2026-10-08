import { createWorldMesh } from '@worldmesh/runtime';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { buildStation } from './world';

const scene = new Scene();
const camera = new PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 900);
const renderer = new WebGLRenderer({ antialias: true });
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const colliders = buildStation(scene);

const world = createWorldMesh({
  scene,
  camera,
  renderer,
  spawn: [0, 2, 14],
  colliders,
  // Preview builds set VITE_PRESENCE_ENDPOINT to their own relay (docs/previews.md).
  multiplayer: import.meta.env.VITE_PRESENCE_ENDPOINT ? { server: import.meta.env.VITE_PRESENCE_ENDPOINT } : true,
  vr: true,
  abilities: {
    flying: true,
    crouching: true,
    doubleJump: true,
  },
  // Station gravity is light, and the deck is small, so falls end quickly.
  movement: {
    gravity: 12,
    jumpSpeed: 6.2,
    fallLimit: -40,
  },
  ui: {
    // No click-to-enter panel: WASD works from the first frame, Esc brings up the menu.
    deferLockPanel: true,
    moveBeforeLock: true,
    title: 'Space Station - Demo',
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
  //   { url: 'http://localhost:5171/', label: 'Forest - Demo', position: [-9, 0, 0], color: 0x8cff9e },
  //   { url: 'http://localhost:5174/', label: 'Medieval Village - Demo', position: [9, 0, 0], color: 0xffd36b },
  // ],
});

if (import.meta.env.DEV) {
  Object.assign(window, { world });
  import.meta.hot?.dispose(() => world.dispose());
}
