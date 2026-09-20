import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Scene,
  HemisphereLight,
} from 'three';

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const NEON = [0xff2f87, 0x2fe0ff, 0xb14bff, 0xffe14b, 0x39ff88];

/** Flat streets on a grid, towers on the blocks between them. */
export function buildCity(scene: Scene): Object3D[] {
  const random = rng(90210);
  const colliders: Object3D[] = [];

  scene.background = new Color(0x0b0f1c);
  scene.fog = new Fog(0x0b0f1c, 40, 190);

  // Night, but readable: a cool skylight plus a low moon so shapes have edges.
  scene.add(new HemisphereLight(0x6f86d6, 0x1c1430, 1.25));
  const moon = new DirectionalLight(0xbcd0ff, 1.5);
  moon.position.set(-30, 50, 25);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024, 1024);
  moon.shadow.camera.left = -70;
  moon.shadow.camera.right = 70;
  moon.shadow.camera.top = 70;
  moon.shadow.camera.bottom = -70;
  moon.shadow.camera.far = 170;
  scene.add(moon);

  const street = new Mesh(
    new PlaneGeometry(300, 300),
    new MeshStandardMaterial({ color: 0x232735, roughness: 0.35, metalness: 0.15 }),
  );
  street.rotation.x = -Math.PI / 2;
  street.receiveShadow = true;
  scene.add(street);
  colliders.push(street);

  const blockSize = 26;
  const roadWidth = 10;
  const towerMaterial = new MeshStandardMaterial({ color: 0x2b3245, roughness: 0.55, metalness: 0.3 });

  for (let gx = -3; gx <= 3; gx++) {
    for (let gz = -3; gz <= 3; gz++) {
      // Leave the middle block empty: that is the plaza you spawn in.
      if (gx === 0 && gz === 0) continue;

      const centerX = gx * (blockSize + roadWidth);
      const centerZ = gz * (blockSize + roadWidth);
      const towers = 1 + Math.floor(random() * 3);

      for (let i = 0; i < towers; i++) {
        const width = 6 + random() * 10;
        const depth = 6 + random() * 10;
        const towerHeight = 10 + random() * 46;
        const x = centerX + (random() - 0.5) * (blockSize - width);
        const z = centerZ + (random() - 0.5) * (blockSize - depth);

        const tower = new Mesh(new BoxGeometry(width, towerHeight, depth), towerMaterial);
        tower.position.set(x, towerHeight / 2, z);
        tower.castShadow = true;
        tower.receiveShadow = true;
        scene.add(tower);
        colliders.push(tower);

        // A neon strip up one face. Emissive only, so it costs nothing.
        const color = NEON[Math.floor(random() * NEON.length)];
        const strip = new Mesh(
          new BoxGeometry(0.4, towerHeight * 0.7, 0.4),
          new MeshBasicMaterial({ color }),
        );
        strip.position.set(x + width / 2 + 0.2, towerHeight * 0.45, z);
        scene.add(strip);

        if (random() > 0.72) {
          const glow = new PointLight(color, 18, 26, 2);
          glow.position.set(x + width / 2 + 1, towerHeight * 0.5, z);
          scene.add(glow);
        }
      }
    }
  }

  // Plaza furniture: crates and a catwalk to climb with a dash + double jump.
  const crateMaterial = new MeshStandardMaterial({ color: 0x2c3244, roughness: 0.7 });
  const crates: [number, number, number][] = [
    [4, 1, -4],
    [6.5, 2, -6],
    [9, 3.2, -8.5],
    [-5, 1, 5],
    [-8, 2.2, 6.5],
  ];
  for (const [x, y, z] of crates) {
    const crate = new Mesh(new BoxGeometry(2.4, y * 2, 2.4), crateMaterial);
    crate.position.set(x, y, z);
    crate.castShadow = true;
    crate.receiveShadow = true;
    scene.add(crate);
    colliders.push(crate);
  }

  const catwalk = new Mesh(
    new BoxGeometry(22, 0.5, 3),
    new MeshStandardMaterial({ color: 0x323a4e, roughness: 0.6, metalness: 0.35 }),
  );
  catwalk.position.set(2, 8, -12);
  catwalk.castShadow = true;
  catwalk.receiveShadow = true;
  scene.add(catwalk);
  colliders.push(catwalk);

  // Street lamps for a sense of scale.
  const poleMaterial = new MeshStandardMaterial({ color: 0x0d0f18, roughness: 0.8 });
  for (let i = -4; i <= 4; i++) {
    for (const side of [-1, 1]) {
      const x = i * 9;
      const z = side * 15;
      const pole = new Mesh(new CylinderGeometry(0.12, 0.14, 6, 6), poleMaterial);
      pole.position.set(x, 3, z);
      scene.add(pole);
      colliders.push(pole);

      const lamp = new Mesh(
        new BoxGeometry(0.8, 0.22, 0.8),
        new MeshBasicMaterial({ color: 0x9fd8ff }),
      );
      lamp.position.set(x, 6.1, z);
      scene.add(lamp);
    }
  }

  return colliders;
}
