import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Scene,
  TorusGeometry,
  Vector3,
} from 'three';
import { withAvatarTicket } from '../avatar/handoff.js';
import { withView } from '../camera/viewHandoff.js';
import type { PortalMode, PortalOptions } from '../types.js';

export interface ResolvedPortal extends PortalOptions {
  label: string;
  radius: number;
  mode: PortalMode;
  object: Object3D | null;
  center: Vector3;
  inside: boolean;
}

/**
 * Portals are the link element of the spatial web. For the MVP "following a
 * link" is literally a page navigation to the destination world's own URL —
 * WorldMesh hosts nothing about the destination. A `from` parameter is added
 * so the destination knows where the visitor came from; state handoff and
 * transitions can be layered on later without changing the world-side API.
 */
export class PortalManager {
  private portals: ResolvedPortal[] = [];
  private scene: Scene;
  private group = new Group();

  constructor(scene: Scene, portals: PortalOptions[] = []) {
    this.scene = scene;
    this.group.name = 'worldmesh:portals';
    this.scene.add(this.group);
    for (const portal of portals) this.add(portal);
  }

  get all(): readonly ResolvedPortal[] {
    return this.portals;
  }

  add(options: PortalOptions): ResolvedPortal {
    const resolved: ResolvedPortal = {
      ...options,
      label: options.label ?? hostLabel(options.url),
      radius: options.radius ?? 2,
      mode: options.mode ?? 'interact',
      object: null,
      center: new Vector3(...options.position),
      inside: false,
    };

    if (options.visual !== false) {
      const visual = options.visual ?? createPortalVisual(resolved.radius, options.color ?? 0x6cf0ff);
      visual.position.copy(resolved.center);
      this.group.add(visual);
      resolved.object = visual;
    }

    this.portals.push(resolved);
    return resolved;
  }

  /** Nearest portal the player is standing in, if any. */
  findActive(feet: Vector3): ResolvedPortal | null {
    let best: ResolvedPortal | null = null;
    let bestDistance = Infinity;
    for (const portal of this.portals) {
      const distance = feet.distanceTo(portal.center);
      // Generous vertical tolerance: the trigger is a stubby cylinder.
      const withinHeight = Math.abs(feet.y - portal.center.y) < portal.radius + 2;
      const active = distance < portal.radius && withinHeight;
      portal.inside = active;
      if (active && distance < bestDistance) {
        best = portal;
        bestDistance = distance;
      }
    }
    return best;
  }

  animate(elapsed: number): void {
    for (const portal of this.portals) {
      if (!portal.object) continue;
      portal.object.rotation.y = elapsed * 0.4;
      portal.object.position.y = portal.center.y + Math.sin(elapsed * 1.2) * 0.08;
    }
  }

  dispose(): void {
    this.group.traverse((child) => {
      if (child instanceof Mesh) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
    this.scene.remove(this.group);
    this.portals = [];
  }
}

/**
 * Build the destination URL, carrying a back-reference to this world, and the
 * visitor's avatar handoff ticket and camera view (in the fragment) if any.
 */
export function buildTravelUrl(target: string): string {
  try {
    const url = new URL(target, window.location.href);
    if (!url.searchParams.has('from')) {
      url.searchParams.set('from', window.location.origin + window.location.pathname);
    }
    // A world's own fragment (e.g. a hash route) is left alone.
    if (url.hash) return url.toString();
    return withView(withAvatarTicket(url)).toString();
  } catch {
    return target;
  }
}

/** Where the visitor came from, if they arrived through a portal. */
export function getReferringWorld(): string | null {
  const from = new URLSearchParams(window.location.search).get('from');
  return from && /^https?:\/\//.test(from) ? from : null;
}

function createPortalVisual(radius: number, color: number | string): Object3D {
  const group = new Group();
  const tint = new Color(color);

  const ring = new Mesh(
    new TorusGeometry(radius * 0.9, radius * 0.08, 10, 40),
    new MeshBasicMaterial({ color: tint }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.05;
  group.add(ring);

  const glow = new Mesh(
    new CircleGeometry(radius * 0.9, 32),
    new MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.22,
      side: DoubleSide,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  group.add(glow);

  const pillar = new Mesh(
    new TorusGeometry(radius * 0.55, radius * 0.04, 8, 32),
    new MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.7 }),
  );
  pillar.rotation.x = Math.PI / 2;
  pillar.position.y = radius * 1.2;
  group.add(pillar);

  return group;
}

function hostLabel(url: string): string {
  try {
    return new URL(url, window.location.href).host;
  } catch {
    return url;
  }
}
