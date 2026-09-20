import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Scene,
  TorusGeometry,
} from 'three';

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const WALL = new MeshStandardMaterial({ color: 0xd9cdb4, roughness: 0.95 });
const BEAM = new MeshStandardMaterial({ color: 0x5b3f2a, roughness: 0.9 });
const ROOF = new MeshStandardMaterial({ color: 0x8c3f32, roughness: 0.85 });
const STONE = new MeshStandardMaterial({ color: 0x8b8880, roughness: 1 });

/** A village square: houses around a well, with a palisade holding it all in. */
export function buildVillage(scene: Scene): Object3D[] {
  const random = rng(1348);
  const colliders: Object3D[] = [];

  scene.background = new Color(0xa9c3d6);
  scene.fog = new Fog(0xa9c3d6, 45, 170);

  scene.add(new HemisphereLight(0xdceaff, 0x3f4030, 1.15));
  const sun = new DirectionalLight(0xfff6e0, 2.0);
  sun.position.set(25, 40, 15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -50;
  sun.shadow.camera.right = 50;
  sun.shadow.camera.top = 50;
  sun.shadow.camera.bottom = -50;
  sun.shadow.camera.far = 120;
  scene.add(sun);

  const ground = new Mesh(
    new PlaneGeometry(200, 200),
    new MeshStandardMaterial({ color: 0x6b6a3e, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  colliders.push(ground);

  const square = new Mesh(
    new CylinderGeometry(16, 16, 0.2, 40),
    new MeshStandardMaterial({ color: 0x8e8672, roughness: 1 }),
  );
  square.position.y = 0.1;
  square.receiveShadow = true;
  scene.add(square);
  colliders.push(square);

  // Houses in a ring around the square, each turned to face the middle.
  for (let i = 0; i < 9; i++) {
    const angle = (i / 9) * Math.PI * 2 + 0.25;
    const distance = 24 + random() * 5;
    const house = buildHouse(3.5 + random() * 2.5, 3 + random() * 1.5);
    house.position.set(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
    house.rotation.y = -angle + Math.PI / 2;
    scene.add(house);
    colliders.push(house);
  }

  // The well, dead centre.
  const well = new Group();
  const rim = new Mesh(new CylinderGeometry(1.6, 1.8, 1.1, 16), STONE);
  rim.position.y = 0.75;
  rim.castShadow = true;
  rim.receiveShadow = true;
  well.add(rim);
  for (const side of [-1, 1]) {
    const post = new Mesh(new BoxGeometry(0.25, 3, 0.25), BEAM);
    post.position.set(side * 1.3, 2.2, 0);
    post.castShadow = true;
    well.add(post);
  }
  const roof = new Mesh(new ConeGeometry(2.4, 1.4, 4), ROOF);
  roof.position.y = 4.3;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  well.add(roof);
  const bucket = new Mesh(new TorusGeometry(0.35, 0.09, 6, 12), BEAM);
  bucket.position.y = 2.6;
  bucket.rotation.x = Math.PI / 2;
  well.add(bucket);
  scene.add(well);
  colliders.push(well);

  // Market stalls and hay bales: low things to hop over.
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + 0.6;
    const distance = 9 + random() * 4;
    const stall = new Mesh(new BoxGeometry(2.6, 1.2, 1.6), BEAM);
    stall.position.set(Math.cos(angle) * distance, 0.7, Math.sin(angle) * distance);
    stall.rotation.y = -angle;
    stall.castShadow = true;
    stall.receiveShadow = true;
    scene.add(stall);
    colliders.push(stall);

    const canopy = new Mesh(new BoxGeometry(3, 0.16, 2), ROOF);
    canopy.position.set(stall.position.x, 2.3, stall.position.z);
    canopy.rotation.y = stall.rotation.y;
    canopy.castShadow = true;
    scene.add(canopy);
  }

  // A palisade with one gap, so the square reads as an enclosed place.
  const palisadeMaterial = new MeshStandardMaterial({ color: 0x6b4a30, roughness: 0.95 });
  const posts = 72;
  for (let i = 0; i < posts; i++) {
    const angle = (i / posts) * Math.PI * 2;
    // Leave a gate facing the spawn side.
    if (angle > Math.PI * 0.42 && angle < Math.PI * 0.58) continue;
    const postHeight = 4 + random();
    const post = new Mesh(new CylinderGeometry(0.28, 0.32, postHeight, 6), palisadeMaterial);
    post.position.set(Math.cos(angle) * 38, postHeight / 2, Math.sin(angle) * 38);
    post.castShadow = true;
    scene.add(post);
    colliders.push(post);
  }

  return colliders;
}

function buildHouse(width: number, houseHeight: number): Object3D {
  const group = new Group();

  const walls = new Mesh(new BoxGeometry(width * 2, houseHeight, width * 1.6), WALL);
  walls.position.y = houseHeight / 2;
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  const roof = new Mesh(new ConeGeometry(width * 1.7, houseHeight * 0.9, 4), ROOF);
  roof.position.y = houseHeight + houseHeight * 0.45;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  group.add(roof);

  const door = new Mesh(new BoxGeometry(0.9, 1.9, 0.12), BEAM);
  door.position.set(0, 0.95, width * 0.8 + 0.06);
  group.add(door);

  for (const side of [-1, 1]) {
    const beam = new Mesh(new BoxGeometry(0.2, houseHeight, 0.2), BEAM);
    beam.position.set(side * (width - 0.2), houseHeight / 2, width * 0.8);
    group.add(beam);
  }

  return group;
}
