import {
  BoxGeometry,
  Color,
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
  SphereGeometry,
} from 'three';

/** Deterministic RNG so the canyon looks the same on every visit. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const dunes = (x: number, z: number): number =>
  Math.sin(x * 0.04) * 1.7 + Math.cos(z * 0.035) * 1.4 + Math.sin((x - z) * 0.02) * 1.1;

export function buildMars(scene: Scene): Object3D[] {
  const random = rng(4242);
  const colliders: Object3D[] = [];

  scene.background = new Color(0xd9a07a);
  scene.fog = new Fog(0xd9a07a, 60, 210);

  scene.add(new HemisphereLight(0xffd0a8, 0x5a2a18, 1.0));
  const sun = new DirectionalLight(0xfff0e0, 2.4);
  sun.position.set(-40, 50, -25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -70;
  sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70;
  sun.shadow.camera.bottom = -70;
  sun.shadow.camera.far = 160;
  scene.add(sun);

  const surfaceAt = (x: number, z: number): number => {
    const distance = Math.hypot(x, z);
    const flatten = Math.min(1, Math.max(0, (distance - 12) / 16));
    return dunes(x, z) * flatten;
  };

  const groundGeometry = new PlaneGeometry(260, 260, 100, 100);
  const position = groundGeometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    position.setZ(i, surfaceAt(x, -y));
  }
  groundGeometry.computeVertexNormals();
  const ground = new Mesh(
    groundGeometry,
    new MeshStandardMaterial({ color: 0xa8502f, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  colliders.push(ground);

  // Mesas: big enough to walk around, low gravity makes them tempting to climb.
  const mesaMaterial = new MeshStandardMaterial({
    color: 0x8f4326,
    roughness: 1,
    flatShading: true,
  });
  const mesas: [number, number, number, number][] = [
    [-34, 26, 9, 14],
    [28, -30, 12, 18],
    [46, 34, 7, 10],
    [-52, -18, 10, 22],
  ];
  for (const [x, z, radius, mesaHeight] of mesas) {
    const mesa = new Mesh(
      new CylinderGeometry(radius * 0.78, radius, mesaHeight, 9, 1),
      mesaMaterial,
    );
    mesa.position.set(x, surfaceAt(x, z) + mesaHeight / 2, z);
    mesa.castShadow = true;
    mesa.receiveShadow = true;
    scene.add(mesa);
    colliders.push(mesa);
  }

  // Boulder field.
  const rockMaterial = new MeshStandardMaterial({
    color: 0x7a3a22,
    roughness: 1,
    flatShading: true,
  });
  for (let i = 0; i < 40; i++) {
    const angle = random() * Math.PI * 2;
    const distance = 10 + random() * 90;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const size = 0.5 + random() * 2.4;
    const rock = new Mesh(new IcosahedronGeometry(size, 0), rockMaterial);
    rock.position.set(x, surfaceAt(x, z) + size * 0.55, z);
    rock.rotation.set(random() * 3, random() * 3, random() * 3);
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);
    colliders.push(rock);
  }

  // A lander, as a landmark to aim at.
  const lander = buildLander();
  lander.position.set(14, surfaceAt(14, 16), 16);
  scene.add(lander);
  colliders.push(lander);

  // Low stepping platforms: with Mars gravity these are one easy hop apart.
  const padMaterial = new MeshStandardMaterial({ color: 0xc27a4f, roughness: 0.9 });
  for (let i = 0; i < 5; i++) {
    const pad = new Mesh(new BoxGeometry(4, 0.6, 4), padMaterial);
    const x = -8 - i * 6;
    const z = -6 - i * 5;
    pad.position.set(x, surfaceAt(x, z) + 1.5 + i * 2.4, z);
    pad.castShadow = true;
    pad.receiveShadow = true;
    scene.add(pad);
    colliders.push(pad);
  }

  return colliders;
}

function buildLander(): Object3D {
  const group = new Mesh(
    new BoxGeometry(3, 2.2, 3),
    new MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.5, metalness: 0.3 }),
  );
  group.position.y = 2.6;
  group.castShadow = true;

  const dome = new Mesh(
    new SphereGeometry(1.3, 16, 10),
    new MeshStandardMaterial({ color: 0x5fd0ff, roughness: 0.2, metalness: 0.1 }),
  );
  dome.position.y = 1.5;
  dome.castShadow = true;
  group.add(dome);

  const legMaterial = new MeshStandardMaterial({ color: 0x9a968e, roughness: 0.6, metalness: 0.4 });
  for (const [dx, dz] of [
    [1.4, 1.4],
    [-1.4, 1.4],
    [1.4, -1.4],
    [-1.4, -1.4],
  ]) {
    const leg = new Mesh(new CylinderGeometry(0.12, 0.12, 3, 6), legMaterial);
    leg.position.set(dx, -2, dz);
    leg.rotation.set(dz * 0.12, 0, -dx * 0.12);
    leg.castShadow = true;
    group.add(leg);
  }

  return group;
}
