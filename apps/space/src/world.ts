import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  SphereGeometry,
  TorusGeometry,
  HemisphereLight,
  DoubleSide,
} from 'three';

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const HULL = new MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.45, metalness: 0.65 });
const DECK = new MeshStandardMaterial({ color: 0x2b3140, roughness: 0.6, metalness: 0.4 });
const TRIM = new MeshBasicMaterial({ color: 0x6cf0ff });

/**
 * An open deck in orbit. There is no ground plane here, so stepping off the
 * edge is a real fall — which is exactly what the shared controller's respawn
 * is for.
 */
export function buildStation(scene: Scene): Object3D[] {
  const random = rng(7771);
  const colliders: Object3D[] = [];

  scene.background = new Color(0x01020a);

  scene.add(new HemisphereLight(0x8fa8ff, 0x0a0c16, 0.5));
  const key = new PointLight(0xdfe9ff, 900, 220, 2);
  key.position.set(20, 40, 20);
  scene.add(key);
  const rim = new PointLight(0x6cf0ff, 350, 140, 2);
  rim.position.set(-25, 12, -30);
  scene.add(rim);

  scene.add(createStarfield(random));

  // The planet below, purely for the view.
  const planet = new Mesh(
    new SphereGeometry(120, 48, 32),
    new MeshStandardMaterial({ color: 0x2b5fa8, roughness: 1, emissive: 0x081832 }),
  );
  planet.position.set(0, -190, -60);
  scene.add(planet);

  const halo = new Mesh(
    new RingGeometry(150, 190, 64),
    new MeshBasicMaterial({
      color: 0x3d7fd6,
      transparent: true,
      opacity: 0.18,
      side: DoubleSide,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  halo.position.copy(planet.position);
  halo.rotation.x = Math.PI / 2.6;
  scene.add(halo);

  // Main deck.
  const deck = new Mesh(new CylinderGeometry(22, 22, 1, 48), DECK);
  deck.position.y = -0.5;
  deck.receiveShadow = true;
  scene.add(deck);
  colliders.push(deck);

  const lip = new Mesh(new TorusGeometry(22, 0.35, 8, 64), TRIM);
  lip.rotation.x = Math.PI / 2;
  scene.add(lip);

  // Spokes reaching out to four pods. Narrow on purpose.
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);

    const spoke = new Mesh(new BoxGeometry(3, 0.8, 26), DECK);
    spoke.position.set(dirX * 33, -0.4, dirZ * 33);
    spoke.rotation.y = -angle + Math.PI / 2;
    scene.add(spoke);
    colliders.push(spoke);

    const pod = new Mesh(new CylinderGeometry(6, 6, 1, 20), DECK);
    pod.position.set(dirX * 50, -0.5, dirZ * 50);
    scene.add(pod);
    colliders.push(pod);

    const dome = new Mesh(
      new SphereGeometry(6, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      new MeshStandardMaterial({
        color: 0x7fd8ff,
        transparent: true,
        opacity: 0.16,
        roughness: 0.1,
        metalness: 0,
        side: DoubleSide,
      }),
    );
    dome.position.set(dirX * 50, 0, dirZ * 50);
    scene.add(dome);

    const podLight = new PointLight(0x6cf0ff, 40, 30, 2);
    podLight.position.set(dirX * 50, 4, dirZ * 50);
    scene.add(podLight);
  }

  // Central tower: the reason flying is enabled here.
  const column = new Mesh(new CylinderGeometry(2.4, 3, 26, 16), HULL);
  column.position.y = 13;
  column.castShadow = true;
  scene.add(column);
  colliders.push(column);

  for (let i = 0; i < 5; i++) {
    const radius = 7 - i * 0.8;
    const ledge = new Mesh(new CylinderGeometry(radius, radius, 0.5, 20), DECK);
    ledge.position.y = 5 + i * 5;
    ledge.receiveShadow = true;
    scene.add(ledge);
    colliders.push(ledge);

    const ring = new Mesh(new TorusGeometry(radius, 0.12, 6, 32), TRIM);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 5.3 + i * 5;
    scene.add(ring);
  }

  // Crates scattered on the deck.
  const crateMaterial = new MeshStandardMaterial({ color: 0x5b6577, roughness: 0.6, metalness: 0.3 });
  for (let i = 0; i < 14; i++) {
    const angle = random() * Math.PI * 2;
    const distance = 8 + random() * 11;
    const size = 0.8 + random() * 1.2;
    const crate = new Mesh(new BoxGeometry(size, size, size), crateMaterial);
    crate.position.set(Math.cos(angle) * distance, size / 2, Math.sin(angle) * distance);
    crate.rotation.y = random() * Math.PI;
    crate.castShadow = true;
    crate.receiveShadow = true;
    scene.add(crate);
    colliders.push(crate);
  }

  return colliders;
}

function createStarfield(random: () => number): Object3D {
  const count = 2400;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Uniform-ish points on a large sphere.
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    const radius = 320 + random() * 90;
    positions[i * 3] = Math.sin(phi) * Math.cos(theta) * radius;
    positions[i * 3 + 1] = Math.cos(phi) * radius;
    positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * radius;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return new Points(geometry, new PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false }));
}
