import {
  animateDefaultAvatar,
  createDefaultAvatar,
  setAvatarExpression,
  type NetworkAdapter,
  type PlayerState,
  type WorldMeshHandle,
} from '@worldmesh/runtime';
import { CanvasTexture, Group, Mesh, Sprite, SpriteMaterial, Vector3, type Object3D, type Scene } from 'three';

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
  /** Text currently drawn on the tag. */
  label: string;
  tag: Sprite;
}

/** Height of the name tag's centre above the avatar's feet. */
const TAG_HEIGHT = 2.15;

type ServerMessage =
  | { t: 'welcome'; id: string; peers: { id: string; p: [number, number, number]; r: number; e?: string; n?: string; a?: string }[] }
  | { t: 's'; id: string; p: [number, number, number]; r: number; e?: string; n?: string; a?: string }
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
  /** Bumped by every connect and disconnect, so a connect waiting on its ticket can tell it was superseded. */
  private connectGen = 0;
  /** The name the current connection asked for a ticket for; null when it connected as a guest. */
  private ticketFor: string | null = null;

  constructor(
    private endpoint: string,
    private room: string,
    scene: Scene,
    private onCount: (count: number | null) => void,
    private getName: () => string | null = () => null,
    /** Made-up name shown instead of the username in private mode. */
    private getAlias: () => string | null = () => null,
    /**
     * A ticket proving getName()'s username to the presence server, or null.
     * Without one, the server shows this visitor as a guest.
     */
    private getTicket: () => Promise<string | null> = async () => null,
  ) {
    this.group.name = 'worldmesh:remote-players';
    scene.add(this.group);
  }

  attach(world: WorldMeshHandle): void {
    this.unsubscribe = world.on('update', ({ state }) => this.sendLocalState(state));
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('pageshow', this.handlePageShow);
    void this.connect();
  }

  sendLocalState(state: PlayerState): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.selfId) return;

    // Signed in after this connection opened: reconnect with a ticket, or the name is refused.
    const name = this.getName();
    if (name && name !== this.ticketFor) {
      this.rejoin();
      return;
    }

    const now = performance.now();
    if (now - this.lastSent < 1000 / SEND_RATE) return;

    const [x, y, z] = state.position;
    const payload = JSON.stringify({ t: 's', p: [round(x), round(y), round(z)], r: round(state.facing), e: state.expression, n: name ?? '', a: this.getAlias() ?? '' });
    if (payload === this.lastPayload && now - this.lastSent < HEARTBEAT_MS) return;

    socket.send(payload);
    this.lastPayload = payload;
    this.lastSent = now;
  }

  /** Ease remote avatars toward their last known position. Call once per frame. */
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
      animateDefaultAvatar(remote.root, { dt, speed: remote.speed, grounded: remote.root.position.y < 0.05 });
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
    void this.connect();
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

  private async connect(): Promise<void> {
    if (this.closed || this.socket) return;
    const gen = ++this.connectGen;

    const name = this.getName();
    let ticket: string | null = null;
    if (name) {
      try {
        ticket = await this.getTicket();
      } catch {
        // No ticket: join as a guest rather than not at all.
      }
      if (gen !== this.connectGen || this.closed || this.socket) return;
    }
    // Remembered even when no ticket came back, so a refusal does not retry on every frame.
    this.ticketFor = name;

    let socket: WebSocket;
    try {
      const query = ticket ? `?ticket=${encodeURIComponent(ticket)}` : '';
      socket = new WebSocket(`${this.endpoint.replace(/\/$/, '')}/room/${this.room}${query}`);
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
    this.connectGen++;
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
    this.reconnectTimer = window.setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        this.selfId = message.id;
        this.backoff = 1000;
        this.lastPayload = '';
        this.lastSent = 0;
        for (const peer of message.peers) this.upsert(peer.id, peer.p, peer.r, peer.e, nameLabel(peer.n, peer.a), true);
        break;
      case 's':
        if (message.id !== this.selfId) this.upsert(message.id, message.p, message.r, message.e, nameLabel(message.n, message.a), false);
        break;
      case 'leave': {
        const remote = this.remotes.get(message.id);
        if (remote) disposeObject(remote.root);
        this.remotes.delete(message.id);
        break;
      }
    }
    this.onCount(this.remotes.size + 1);
  }

  private upsert(
    id: string,
    p: [number, number, number],
    yaw: number,
    expression: unknown,
    label: string,
    snap: boolean,
  ): void {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite) || !Number.isFinite(yaw)) return;

    let remote = this.remotes.get(id);
    if (!remote) {
      const root = createDefaultAvatar();
      const tag = createNameTag(GUEST);
      tag.position.y = TAG_HEIGHT;
      root.add(tag);
      this.group.add(root);
      remote = { root, target: new Vector3(), targetYaw: yaw, yaw, speed: 0, label: GUEST, tag };
      this.remotes.set(id, remote);
      snap = true;
    }
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
    if (remote.root.position.distanceTo(remote.target) > 6) snap = true;
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
      void this.connect();
    }
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const GUEST = 'Guest';

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
