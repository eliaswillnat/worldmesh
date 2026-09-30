import { BoxGeometry, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, type BufferGeometry, type Texture } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CategoryRegistry } from '../worlds/categories';
import type { CityConfig } from './config';
import type { CityMaterials } from './materials';
import type { BridgePlan, CityPlan } from './plan';
import { drawBand, SIGN_FONT, spaced } from './signage';

/**
 * Skybridges between towers. Each is a deck with low parapets and glass (for
 * the views), a spine underneath, a gantry at mid-span naming both ends, and
 * a sign over each tower's bridge mouth naming where it leads, readable
 * before anyone steps onto it. All bridges share two merged meshes; signs
 * are one small mesh each.
 */
export class BridgeManager {
  readonly group = new Group();
  readonly colliders: Mesh[] = [];
  private geometries: BufferGeometry[] = [];
  private textures: Texture[] = [];
  private signMaterials: MeshBasicMaterial[] = [];

  constructor(
    private plan: CityPlan,
    private config: CityConfig,
    materials: CityMaterials,
    categories: CategoryRegistry,
  ) {
    this.group.name = 'bridges';
    const structure: BufferGeometry[] = [];
    const trim: BufferGeometry[] = [];
    const glass: BufferGeometry[] = [];
    const matrix = new Matrix4();

    for (const bridge of plan.bridges) {
      const frame = new Matrix4().makeRotationY(bridge.heading).setPosition(bridge.start.x, bridge.y, bridge.start.z);
      const L = bridge.length;
      const W = config.bridgeWidth;
      const clear = config.wallThickness + 0.3;
      const span = L - clear * 2;
      const add = (list: BufferGeometry[], geometry: BufferGeometry, x: number, y: number, z: number) => {
        const g = geometry.toNonIndexed();
        geometry.dispose();
        g.applyMatrix4(matrix.makeTranslation(x, y, z).premultiply(frame));
        list.push(g);
      };

      add(structure, new BoxGeometry(W, 0.7, L), 0, -0.35, L / 2);
      add(structure, new BoxGeometry(1.4, 1.5, span), 0, -1.45, L / 2);
      for (let z = clear + 4; z < L - clear - 2; z += 9) add(structure, new BoxGeometry(W - 0.4, 0.45, 0.5), 0, -0.9, z);
      for (const side of [-1, 1]) {
        add(structure, new BoxGeometry(0.3, 0.4, span), side * (W / 2 - 0.15), 0.2, L / 2);
        add(glass, new BoxGeometry(0.04, 0.72, span), side * (W / 2 - 0.15), 0.76, L / 2);
        add(trim, new BoxGeometry(0.06, 0.05, span), side * (W / 2 - 0.15), 1.14, L / 2);
        add(trim, new BoxGeometry(0.05, 0.03, span), side * (W / 2 - 0.45), 0.015, L / 2);
        // Gantry posts at mid-span.
        add(structure, new BoxGeometry(0.5, 6.6, 0.5), side * (W / 2 + 0.25), 3.3, L / 2);
      }
      add(structure, new BoxGeometry(W + 1.2, 0.7, 0.6), 0, 6.6, L / 2);
      add(trim, new BoxGeometry(W + 1.2, 0.04, 0.62), 0, 6.24, L / 2);

      // Colliders: the deck top, and the parapets facing in toward the walkway.
      const deck = new Mesh(new PlaneGeometry(W, L).rotateX(-Math.PI / 2).translate(0, 0, L / 2));
      const left = new Mesh(new PlaneGeometry(span, 1.5).rotateY(Math.PI / 2).translate(-(W / 2 - 0.3), 0.75, L / 2));
      const right = new Mesh(new PlaneGeometry(span, 1.5).rotateY(-Math.PI / 2).translate(W / 2 - 0.3, 0.75, L / 2));
      for (const collider of [deck, left, right]) {
        collider.visible = false;
        collider.applyMatrix4(frame);
        collider.updateMatrixWorld(true);
        this.colliders.push(collider);
      }

      const from = categories.get(bridge.from)!;
      const to = categories.get(bridge.to)!;
      // Gantry signs: the far end's name, facing whoever walks toward it.
      this.sign(`→ ${spaced(to.name)}`, to.color, frame, 0, 5.3, L / 2 - 0.32, Math.PI, W);
      this.sign(`→ ${spaced(from.name)}`, from.color, frame, 0, 5.3, L / 2 + 0.32, 0, W);
      // Mouth signs inside each tower, over the opening.
      this.mouthSign(bridge, bridge.from, to.name, to.color);
      this.mouthSign(bridge, bridge.to, from.name, from.color);
    }

    const merged = (list: BufferGeometry[], material: CityMaterials[keyof Pick<CityMaterials, 'structure' | 'trim' | 'glass'>]) => {
      if (!list.length) return;
      const geometry = mergeGeometries(list);
      for (const g of list) g.dispose();
      this.geometries.push(geometry);
      this.group.add(new Mesh(geometry, material));
    };
    merged(structure, materials.structure);
    merged(trim, materials.trim);
    merged(glass, materials.glass);
  }

  /** Which bridge (if any) the point is on, and how far along it (0 at `from`, 1 at `to`). */
  locate(x: number, y: number, z: number): { bridge: BridgePlan; t: number } | null {
    for (const bridge of this.plan.bridges) {
      if (Math.abs(y - bridge.y) > 1.5) continue;
      const dx = bridge.end.x - bridge.start.x;
      const dz = bridge.end.z - bridge.start.z;
      const t = ((x - bridge.start.x) * dx + (z - bridge.start.z) * dz) / (bridge.length * bridge.length);
      if (t < 0 || t > 1) continue;
      const px = bridge.start.x + dx * t;
      const pz = bridge.start.z + dz * t;
      if (Math.hypot(x - px, z - pz) < this.config.bridgeWidth / 2 + 0.2) return { bridge, t };
    }
    return null;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const texture of this.textures) texture.dispose();
    for (const material of this.signMaterials) material.dispose();
    for (const collider of this.colliders) collider.geometry.dispose();
    this.group.removeFromParent();
  }

  private sign(text: string, color: string, frame: Matrix4, x: number, y: number, z: number, turn: number, width: number): void {
    const texture = drawBand([{ text, color: '#ffffff', font: `700 92px ${SIGN_FONT}` }], { width: 1024, height: 200, background: '#121316' });
    this.textures.push(texture);
    const material = new MeshBasicMaterial({ map: texture, toneMapped: false, side: DoubleSide });
    this.signMaterials.push(material);
    const w = Math.min(width, 5.2);
    const geometry = new PlaneGeometry(w, w * (200 / 1024));
    this.geometries.push(geometry);
    const mesh = new Mesh(geometry, material);
    mesh.applyMatrix4(new Matrix4().makeRotationY(turn).setPosition(x, y, z).premultiply(frame));
    this.group.add(mesh);
    // A bar of the destination's colour under the sign.
    const barMaterial = new MeshBasicMaterial({ color, toneMapped: false, side: DoubleSide });
    this.signMaterials.push(barMaterial);
    const barGeometry = new PlaneGeometry(w, 0.09);
    this.geometries.push(barGeometry);
    const bar = new Mesh(barGeometry, barMaterial);
    bar.applyMatrix4(new Matrix4().makeRotationY(turn).setPosition(x, y - (w * (200 / 1024)) / 2 - 0.08, z).premultiply(frame));
    this.group.add(bar);
  }

  private mouthSign(bridge: BridgePlan, towerId: string, destination: string, color: string): void {
    const tower = this.plan.tower(towerId)!;
    const angle = towerId === bridge.from ? bridge.heading : bridge.heading + Math.PI;
    const r = this.config.towerRadius - 0.25;
    const frame = new Matrix4().makeRotationY(angle + Math.PI).setPosition(tower.center.x + Math.sin(angle) * r, bridge.y, tower.center.z + Math.cos(angle) * r);
    this.sign(`BRIDGE → ${spaced(destination)}`, color, frame, 0, 6.3, 0, 0, this.config.bridgeWidth + 1.5);
  }
}
