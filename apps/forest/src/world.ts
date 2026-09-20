import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  HemisphereLight,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Scene,
} from 'three';

/** Deterministic RNG so the clearing looks the same on every visit. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const groundHeight = (x: number, z: number): number =>
  Math.sin(x * 0.06) * 0.9 + Math.cos(z * 0.05) * 0.8 + Math.sin((x + z) * 0.03) * 0.6;

export function buildForest(scene: Scene): Object3D[] {
  const random = rng(20260920);
  const colliders: Object3D[] = [];

  scene.background = new Color(0x9dc7d8);
  scene.fog = new Fog(0x9dc7d8, 40, 150);

  scene.add(new HemisphereLight(0xbfe3ff, 0x2c3a24, 1.1));
  const sun = new DirectionalLight(0xfff2d6, 2.1);
  sun.position.set(30, 45, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  sun.shadow.camera.far = 140;
  scene.add(sun);

  // Rolling ground, flattened near spawn so you always land somewhere sane.
  const surfaceAt = (x: number, z: number): number => {
    const distance = Math.hypot(x, z);
    const flatten = Math.min(1, Math.max(0, (distance - 10) / 14));
    return groundHeight(x, z) * flatten;
  };

  const groundGeometry = new PlaneGeometry(220, 220, 90, 90);
  const position = groundGeometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    // The plane is rotated -90deg about X, so its local +Y maps to world -Z.
    position.setZ(i, surfaceAt(position.getX(i), -position.getY(i)));
  }
  groundGeometry.computeVertexNormals();
  const ground = new Mesh(
    groundGeometry,
    new MeshStandardMaterial({ color: 0x4d6b3c, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  colliders.push(ground);

  // Trees. Trunks block movement, canopies do not.
  const trunkGeometry = new CylinderGeometry(0.22, 0.32, 5, 7);
  const trunkMaterial = new MeshStandardMaterial({ color: 0x5a3f2b, roughness: 0.9 });
  const canopyGeometry = new ConeGeometry(2.1, 5.5, 8);
  const canopyMaterial = new MeshStandardMaterial({ color: 0x2f5a30, roughness: 0.95 });

  for (let i = 0; i < 120; i++) {
    const angle = random() * Math.PI * 2;
    const distance = 12 + random() * 88;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const y = surfaceAt(x, z);
    const scale = 0.7 + random() * 0.8;

    const trunk = new Mesh(trunkGeometry, trunkMaterial);
    trunk.position.set(x, y + 2.5 * scale, z);
    trunk.scale.setScalar(scale);
    trunk.castShadow = true;
    scene.add(trunk);
    colliders.push(trunk);

    const canopy = new Mesh(canopyGeometry, canopyMaterial);
    canopy.position.set(x, y + (5 + random() * 0.8) * scale, z);
    canopy.scale.setScalar(scale);
    canopy.castShadow = true;
    scene.add(canopy);
  }

  // Rocks, for something to bump into and stand on.
  const rockMaterial = new MeshStandardMaterial({ color: 0x7c7a72, roughness: 1, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const angle = random() * Math.PI * 2;
    const distance = 8 + random() * 60;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const size = 0.6 + random() * 1.8;
    const rock = new Mesh(new IcosahedronGeometry(size, 0), rockMaterial);
    rock.position.set(x, surfaceAt(x, z) + size * 0.5, z);
    rock.rotation.set(random(), random(), random());
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);
    colliders.push(rock);
  }

  // A little platform stack: proves jumping, double jump and step-up.
  const plankMaterial = new MeshStandardMaterial({ color: 0x8a6743, roughness: 0.8 });
  const steps: [number, number, number][] = [
    [-6, 1.2, -4],
    [-9, 2.6, -7],
    [-12, 4.2, -10],
    [-15.5, 6, -13],
  ];
  for (const [x, y, z] of steps) {
    const plank = new Mesh(new BoxGeometry(3.4, 0.5, 3.4), plankMaterial);
    plank.position.set(x, y, z);
    plank.castShadow = true;
    plank.receiveShadow = true;
    scene.add(plank);
    colliders.push(plank);
  }

  return colliders;
}
