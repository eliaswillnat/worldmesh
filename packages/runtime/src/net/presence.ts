import { CanvasTexture, Group, Mesh, MeshBasicMaterial, Sprite, SpriteMaterial, Vector3, type Object3D, type Scene } from 'three';
import { animateDefaultAvatar, createDefaultAvatar, setAvatarExpression } from '../player/avatar.js';
import { setFigureStroke } from '../player/stroke.js';
import type { NetworkAdapter, PeerBody, PlayerState, WorldMeshHandle } from '../types.js';

/** The relay WorldMesh hosts (workers/presence). Worlds can point at their own. */
export const DEFAULT_PRESENCE_SERVER = 'wss://worldmesh-presence.elias-willnat.workers.dev';

export interface PresenceOptions {
  /** Full WebSocket URL of the room, e.g. `wss://relay.example/world`. */
  url: string;
  scene: Scene;
  /** Players in the room including this one, or null while disconnected. */
  onCount?: (count: number | null) => void;
  getName?: () => string | null;
  /** Made-up name shown instead of the username in private mode. */
  getAlias?: () => string | null;
  /**
   * Someone new just started walking here, first seen at (x, z). Not called
   * for the people already in the room when this visitor joins.
   */
  onArrive?: (x: number, z: number) => void;
  /** Called with each remote figure as it is made, already outlined. */
  onFigure?: (root: Object3D) => void;
}

/** How often the local position goes out, per second. */
const SEND_RATE = 10;
/** Resend at least this often while standing still, so late joiners see us. */
const HEARTBEAT_MS = 3000;
const MAX_BACKOFF_MS = 30_000;

interface Remote {
  root: Object3D;
  target: Vector3;
  targetYaw: number;
  yaw: number;
  /** Smoothed horizontal speed, estimated from how far the avatar moves. */
  speed: number;
  /** Standing on something (floor, platform, step) rather than in the air. */
  grounded: boolean;
  /** Text currently drawn on the tag. */
  label: string;
  tag: Sprite;
  /** Seconds since this figure first appeared; drives spawn fade-in. */
  appear: number;
  /** What they just said, stuck above their head until it runs out. */
  bubble: Sprite | null;
  bubbleLeft: number;
}

/**
 * For peers that do not send `g`: a height change smaller than this between
 * two updates is standing, not jumping or falling.
 */
const GROUND_HOLD = 0.02;

/** The size of a remote figure for collisions: the default player's. */
const BODY_RADIUS = 0.35;
const BODY_HEIGHT = 1.8;

/** Height of the name tag's centre above the avatar's feet. */
const TAG_HEIGHT = 2.15;

/** Where a peer is. `g` is 1 on the ground, 0 in the air; older peers leave it out. */
interface PeerState {
  p: [number, number, number];
  r: number;
  e?: string;
  n?: string;
  a?: string;
  g?: number;
}

type ServerMessage =
  | { t: 'welcome'; id: string; peers: (PeerState & { id: string })[] }
  | ({ t: 's'; id: string } & PeerState)
  | { t: 'c'; id: string; m: string }
  | { t: 'leave'; id: string };

/**
 * Shows everyone else who is walking the same room, through the runtime's
 * NetworkAdapter seam. The connection is best-effort: if the presence server
 * is unreachable the lobby simply stays single-player.
 */
export class Presence implements NetworkAdapter {
  private socket: WebSocket | null = null;
  private selfId: string | null = null;
  private remotes = new Map<string, Remote>();
  private group = new Group();
  private unsubscribe: (() => void) | null = null;
  private backoff = 1000;
  private reconnectTimer = 0;
  private closed = false;
  private lastSent = 0;
  private lastPayload = '';

  private url: string;
  private onCount: (count: number | null) => void;
  private getName: () => string | null;
  private getAlias: () => string | null;
  private onArrive: (x: number, z: number) => void;
  private onFigure: (root: Object3D) => void;

  constructor(options: PresenceOptions) {
    this.url = options.url;
    this.onCount = options.onCount ?? (() => {});
    this.getName = options.getName ?? (() => null);
    this.getAlias = options.getAlias ?? (() => null);
    this.onArrive = options.onArrive ?? (() => {});
    this.onFigure = options.onFigure ?? (() => {});
    this.group.name = 'worldmesh:remote-players';
    options.scene.add(this.group);
  }

  attach(world: WorldMeshHandle): void {
    this.unsubscribe = world.on('update', ({ dt, state }) => {
      this.sendLocalState(state);
      this.update(dt);
    });
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('pageshow', this.handlePageShow);
    this.connect();
  }

  sendLocalState(state: PlayerState): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.selfId) return;

    const now = performance.now();
    if (now - this.lastSent < 1000 / SEND_RATE) return;

    const [x, y, z] = state.position;
    const payload = JSON.stringify({ t: 's', p: [round(x), round(y), round(z)], r: round(state.facing), e: state.expression, n: this.getName() ?? '', a: this.getAlias() ?? '', g: state.onGround || state.flying ? 1 : 0 });
    if (payload === this.lastPayload && now - this.lastSent < HEARTBEAT_MS) return;

    socket.send(payload);
    this.lastPayload = payload;
    this.lastSent = now;
  }

  /** Say something. Everyone else gets a bubble; this client draws its own. */
  say(text: string): void {
    const socket = this.socket;
    const line = text.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
    if (!line || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ t: 'c', m: line }));
  }

  /** Everyone else's body where it is drawn, so walking into them stops where they appear to be. */
  bodies(): PeerBody[] {
    const bodies: PeerBody[] = [];
    for (const { root } of this.remotes.values()) {
      const { x, y, z } = root.position;
      bodies.push({ x, y, z, radius: BODY_RADIUS, height: BODY_HEIGHT });
    }
    return bodies;
  }

  /** Ease remote avatars toward their last known position. Driven by the world's update event. */
  update(dt: number): void {
    const blend = 1 - Math.exp(-dt * 10);
    for (const remote of this.remotes.values()) {
      const before = remote.root.position.clone();
      remote.root.position.lerp(remote.target, blend);

      let delta = remote.targetYaw - remote.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      remote.yaw += delta * blend;
      remote.root.rotation.y = remote.yaw;

      const moved = Math.hypot(remote.root.position.x - before.x, remote.root.position.z - before.z);
      remote.speed += (moved / Math.max(dt, 1e-4) - remote.speed) * blend;
      animateDefaultAvatar(remote.root, { dt, speed: remote.speed, grounded: remote.grounded });

      if (remote.bubble) {
        remote.bubbleLeft -= dt;
        remote.bubble.material.opacity = remote.bubbleLeft < 1 ? Math.max(0, remote.bubbleLeft) : 1;
        if (remote.bubbleLeft <= 0) dropBubble(remote);
      }

      // The frame that crosses the end of the fade lands on fully opaque, however long it was.
      const fading = remote.appear < APPEAR_FADE;
      remote.appear += dt;
      if (fading) {
        const t = Math.min(1, remote.appear / APPEAR_FADE);
        setFigureOpacity(remote.root, t * t * (3 - 2 * t));
      }
    }
  }

  /**
   * Leave and re-enter the room as a new peer. Everyone else sees this
   * visitor leave and someone new arrive, with nothing linking the two.
   */
  rejoin(): void {
    if (this.closed) return;
    window.clearTimeout(this.reconnectTimer);
    this.disconnect();
    this.backoff = 1000;
    this.connect();
  }

  detach(): void {
    this.closed = true;
    window.clearTimeout(this.reconnectTimer);
    window.removeEventListener('pagehide', this.handlePageHide);
    window.removeEventListener('pageshow', this.handlePageShow);
    this.unsubscribe?.();
    this.disconnect();
    this.group.removeFromParent();
  }

  private connect(): void {
    if (this.closed || this.socket) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(message);
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.selfId = null;
      this.clearRemotes();
      this.onCount(null);
      this.scheduleReconnect();
    });
  }

  private disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.selfId = null;
    socket?.close(1000, 'bye');
    this.clearRemotes();
    this.onCount(null);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        this.selfId = message.id;
        this.backoff = 1000;
        this.lastPayload = '';
        this.lastSent = 0;
        for (const peer of message.peers) this.upsert(peer.id, peer, true);
        break;
      case 's':
        if (message.id !== this.selfId) this.upsert(message.id, message, false);
        break;
      case 'c': {
        const remote = message.id === this.selfId ? undefined : this.remotes.get(message.id);
        if (remote && typeof message.m === 'string') showBubble(remote, message.m);
        break;
      }
      case 'leave': {
        const remote = this.remotes.get(message.id);
        if (remote) disposeObject(remote.root);
        this.remotes.delete(message.id);
        break;
      }
    }
    this.onCount(this.remotes.size + 1);
  }

  private upsert(id: string, state: PeerState, snap: boolean): void {
    const { p, r: yaw, e: expression, g } = state;
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite) || !Number.isFinite(yaw)) return;
    const label = nameLabel(state.n, state.a);

    let remote = this.remotes.get(id);
    if (!remote) {
      const root = createDefaultAvatar();
      const tag = createNameTag(GUEST);
      tag.position.y = TAG_HEIGHT;
      root.add(tag);
      setFigureStroke(root, true);
      this.onFigure(root);
      this.group.add(root);
      remote = { root, target: new Vector3(p[0], p[1], p[2]), targetYaw: yaw, yaw, speed: 0, grounded: true, label: GUEST, tag, appear: 0, bubble: null, bubbleLeft: 0 };
      this.remotes.set(id, remote);
      setFigureOpacity(root, 0);
      if (!snap) this.onArrive(p[0], p[2]);
      snap = true;
    }
    // Peers that do not say whether they are grounded count as standing when
    // their height holds still, so a raised floor like the spawn platform
    // does not leave them in the jump pose.
    remote.grounded = g === 0 || g === 1 ? g === 1 : p[1] < 0.05 || Math.abs(p[1] - remote.target.y) < GROUND_HOLD;
    remote.target.set(p[0], p[1], p[2]);
    remote.targetYaw = yaw;
    if (typeof expression === 'string') setAvatarExpression(remote.root, expression);
    if (label !== remote.label) {
      remote.label = label;
      disposeObject(remote.tag);
      remote.tag = createNameTag(label);
      remote.tag.position.y = TAG_HEIGHT;
      remote.root.add(remote.tag);
    }
    // A long jump is a teleport or respawn, not a sprint: do not animate it.
    if (remote.root.position.distanceTo(remote.target) > 6) {
      snap = true;
      remote.appear = 0;
      setFigureOpacity(remote.root, 0);
    }
    if (snap) {
      remote.root.position.copy(remote.target);
      remote.yaw = yaw;
    }
  }

  private clearRemotes(): void {
    for (const remote of this.remotes.values()) disposeObject(remote.root);
    this.remotes.clear();
  }

  // Leave the room promptly when the tab navigates away (e.g. through a door),
  // and rejoin if the browser restores the page from its back/forward cache.
  private handlePageHide = (): void => {
    window.clearTimeout(this.reconnectTimer);
    this.disconnect();
  };

  private handlePageShow = (event: PageTransitionEvent): void => {
    if (event.persisted && !this.closed) {
      this.backoff = 1000;
      this.connect();
    }
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** How long a newly appeared figure takes to go from transparent to opaque. */
const APPEAR_FADE = 0.55;

const GUEST = 'Guest';

/** Ease every mesh on an avatar toward a shared opacity. */
function setFigureOpacity(root: Object3D, amount: number): void {
  const solid = amount >= 0.999;
  let outlined = false;
  root.traverse((child) => {
    if (child instanceof Mesh && child.userData.stroke === true) outlined = true;
  });
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      const stroke = material.userData.stroke === true;
      const face = material instanceof MeshBasicMaterial && !stroke;
      material.transparent = face || !solid;
      material.opacity = amount;
      // An outline sits behind the body, so a fading body still writes depth
      // to keep the outline's far side from showing through it as a black blob.
      material.depthWrite = stroke ? solid : !face && (solid || outlined);
      material.needsUpdate = true;
    }
  });
  for (const child of root.children) {
    if (!(child instanceof Sprite)) continue;
    child.material.opacity = amount;
    child.material.transparent = true;
  }
}

/**
 * '@username' for a signed-in visitor, their made-up name in private mode,
 * or 'Guest'. Only real usernames get the '@'.
 */
function nameLabel(name: unknown, alias: unknown): string {
  if (typeof name === 'string' && name) return `@${name}`;
  if (typeof alias === 'string' && alias) return alias;
  return GUEST;
}

/** A camera-facing label over a remote avatar. Guests are drawn dimmer. */
const BUBBLE_LIFE = 7;

/** Stick a line of text over a remote figure. The next line replaces it. */
function showBubble(remote: Remote, text: string): void {
  dropBubble(remote);
  const bubble = createSpeechBubble(text);
  bubble.position.y = TAG_HEIGHT + 0.42;
  remote.root.add(bubble);
  remote.bubble = bubble;
  remote.bubbleLeft = BUBBLE_LIFE;
}

function dropBubble(remote: Remote): void {
  const bubble = remote.bubble;
  if (!bubble) return;
  bubble.material.map?.dispose();
  bubble.material.dispose();
  bubble.removeFromParent();
  remote.bubble = null;
}

/** A white speech bubble. One line, cut off if they wrote a novel. */
function createSpeechBubble(text: string): Sprite {
  const scale = 2;
  const font = `600 ${20 * scale}px system-ui, -apple-system, sans-serif`;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  context.font = font;
  const padX = 16 * scale;
  const height = 40 * scale;
  const maxWidth = 280 * scale;
  const measured = context.measureText(text).width;
  canvas.width = Math.ceil(Math.min(maxWidth, measured) + padX * 2);
  canvas.height = height;

  context.font = font;
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.roundRect(0, 0, canvas.width, height, 14 * scale);
  context.fill();
  context.fillStyle = '#111111';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, height / 2, maxWidth);

  const texture = new CanvasTexture(canvas);
  const sprite = new Sprite(new SpriteMaterial({ map: texture, depthWrite: false, transparent: true }));
  const worldHeight = 0.34;
  sprite.scale.set((worldHeight * canvas.width) / height, worldHeight, 1);
  sprite.name = 'worldmesh:speech';
  sprite.center.set(0.5, 0);
  return sprite;
}

function createNameTag(text: string): Sprite {
  const scale = 2; // Canvas pixels per CSS pixel, for crisp text.
  const font = `600 ${22 * scale}px system-ui, -apple-system, sans-serif`;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  context.font = font;
  const padX = 12 * scale;
  const height = 36 * scale;
  canvas.width = Math.ceil(context.measureText(text).width + padX * 2);
  canvas.height = height;

  context.font = font;
  context.fillStyle = 'rgba(0, 0, 0, 0.55)';
  context.beginPath();
  context.roundRect(0, 0, canvas.width, height, height / 2);
  context.fill();
  context.fillStyle = text === GUEST ? 'rgba(255, 255, 255, 0.7)' : '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, height / 2 + scale);

  const texture = new CanvasTexture(canvas);
  texture.anisotropy = 4;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, depthWrite: false, transparent: true }));
  const worldHeight = 0.26;
  sprite.scale.set((worldHeight * canvas.width) / height, worldHeight, 1);
  sprite.name = 'worldmesh:name-tag';
  return sprite;
}

function disposeObject(root: Object3D): void {
  root.traverse((child) => {
    if (child instanceof Sprite) {
      child.material.map?.dispose();
      child.material.dispose();
    } else if (child instanceof Mesh) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });
  root.removeFromParent();
}
