import { BoxGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, TorusGeometry, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CityConfig } from './config';
import type { CityPlan, TowerPlan } from './plan';

/**
 * Ground paths across the plaza. A ring just outside the citadel links every
 * tower, and a straight path runs from that ring to each entrance. Only the
 * lip is drawn, the same thin ring as the spawn dais, so the mirror floor
 * stays visible.
 */
export class PathManager {
  readonly group = new Group();
  private geometries: BufferGeometry[] = [];
  private readonly lip = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false });

  constructor(plan: CityPlan, config: CityConfig, citadelOuter: number, light: boolean) {
    this.group.name = 'paths';
    const width = 2.4;
    const half = width / 2;
    const ring = citadelOuter + 8;
    const reach = config.towerRadius + config.wallThickness + 0.8;
    const lines: BufferGeometry[] = [];

    for (const radius of [ring - half, ring + half]) {
      const tube = 0.008;
      const geometry = new TorusGeometry(radius, tube, 6, Math.max(160, Math.ceil(radius * 4)));
      geometry.rotateX(Math.PI / 2);
      geometry.translate(0, 0.012, 0);
      this.geometries.push(geometry);
      this.group.add(new Mesh(geometry, this.lip));
    }

    const towers = [...plan.towers].sort((a, b) => Math.atan2(a.center.x, a.center.z) - Math.atan2(b.center.x, b.center.z));
    const outer = ring + half;
    const doors = towers.map((tower) => {
      const angle = Math.atan2(tower.center.x, tower.center.z);
      const door = this.entrance(tower, angle, reach);
      // Start on the outer lip so the spoke meets the ring instead of crossing it.
      const t0 = Math.sqrt(Math.max(outer * outer - half * half, 0));
      this.pair(lines, anglePoint(angle, t0), door, width);
      return door;
    });
    for (let i = 0; i < doors.length; i++) {
      const span = inset(doors[i], doors[(i + 1) % doors.length], 2.2);
      if (span) this.pair(lines, span.from, span.to, width);
    }

    this.merged(lines);
    this.setTheme(light);
  }

  /** Same lip colour as the spawn dais. */
  setTheme(light: boolean): void {
    this.lip.color.set(light ? 0x3a3d44 : 0xffffff);
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    this.lip.dispose();
    this.group.removeFromParent();
  }

  private entrance(tower: TowerPlan, angle: number, reach: number): { x: number; z: number } {
    return { x: tower.center.x - Math.sin(angle) * reach, z: tower.center.z - Math.cos(angle) * reach };
  }

  /** Two lips, `width` apart, running from `from` to `to`. */
  private pair(list: BufferGeometry[], from: { x: number; z: number }, to: { x: number; z: number }, width: number): void {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.3) return;
    const px = (-dz / length) * (width / 2);
    const pz = (dx / length) * (width / 2);
    this.line(list, { x: from.x + px, z: from.z + pz }, { x: to.x + px, z: to.z + pz });
    this.line(list, { x: from.x - px, z: from.z - pz }, { x: to.x - px, z: to.z - pz });
  }

  private line(list: BufferGeometry[], from: { x: number; z: number }, to: { x: number; z: number }): void {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.05) return;
    const frame = new Matrix4().makeRotationY(Math.atan2(dx, dz)).setPosition(from.x, 0, from.z);
    const geometry = new BoxGeometry(0.016, 0.016, length).toNonIndexed();
    geometry.applyMatrix4(new Matrix4().makeTranslation(0, 0.012, length / 2).premultiply(frame));
    list.push(geometry);
  }

  private merged(list: BufferGeometry[]): void {
    if (!list.length) return;
    const geometry = mergeGeometries(list);
    for (const g of list) g.dispose();
    if (!geometry) return;
    this.geometries.push(geometry);
    this.group.add(new Mesh(geometry, this.lip));
  }
}

function anglePoint(angle: number, radius: number): { x: number; z: number } {
  return { x: Math.sin(angle) * radius, z: Math.cos(angle) * radius };
}

/** Pull both ends in so two paths can meet without their lines crossing. */
function inset(from: { x: number; z: number }, to: { x: number; z: number }, dist: number): { from: { x: number; z: number }; to: { x: number; z: number } } | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length < dist * 2 + 0.5) return null;
  const ux = dx / length;
  const uz = dz / length;
  return {
    from: { x: from.x + ux * dist, z: from.z + uz * dist },
    to: { x: to.x - ux * dist, z: to.z - uz * dist },
  };
}
