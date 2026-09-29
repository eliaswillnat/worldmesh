import type { NetworkAdapter, PlayerState, WorldMeshHandle } from '@worldmesh/runtime';
import { Group, MathUtils, Vector3, type Object3D, type Scene } from 'three';
import { createAvatar, disposeObject } from './avatar';

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
  walkPhase: number;
}

type ServerMessage =
  | { t: 'welcome'; id: string; peers: { id: string; p: [number, number, number]; r: number }[] }
  | { t: 's'; id: string; p: [number, number, number]; r: number }
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

  constructor(
    private endpoint: string,
    private room: string,
    scene: Scene,
    private onCount: (count: number | null) => void,
  ) {
    this.group.name = 'worldmesh:remote-players';
    scene.add(this.group);
  }

  attach(world: WorldMeshHandle): void {
    this.unsubscribe = world.on('update', ({ state }) => this.sendLocalState(state));
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
    const payload = JSON.stringify({ t: 's', p: [round(x), round(y), round(z)], r: round(state.yaw) });
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

      // A small bob while moving, so a walking visitor reads as walking.
      const speed = before.distanceTo(remote.root.position) / Math.max(dt, 1e-4);
      const moving = MathUtils.clamp(speed / 4, 0, 1);
      remote.walkPhase += dt * 10 * moving;
      const body = remote.root.children[0];
      if (body) body.position.y = Math.abs(Math.sin(remote.walkPhase)) * 0.06 * moving;
    }
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
      socket = new WebSocket(`${this.endpoint.replace(/\/$/, '')}/room/${this.room}`);
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
        for (const peer of message.peers) this.upsert(peer.id, peer.p, peer.r, true);
        break;
      case 's':
        if (message.id !== this.selfId) this.upsert(message.id, message.p, message.r, false);
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

  private upsert(id: string, p: [number, number, number], yaw: number, snap: boolean): void {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite) || !Number.isFinite(yaw)) return;

    let remote = this.remotes.get(id);
    if (!remote) {
      // Wrap the body so the walk bob does not fight the interpolated position.
      const root = new Group();
      root.add(createAvatar());
      this.group.add(root);
      remote = { root, target: new Vector3(), targetYaw: yaw, yaw, walkPhase: 0 };
      this.remotes.set(id, remote);
      snap = true;
    }
    remote.target.set(p[0], p[1], p[2]);
    remote.targetYaw = yaw;
    if (snap) {
      remote.root.position.copy(remote.target);
      remote.yaw = yaw;
    }
  }

  private clearRemotes(): void {
    for (const remote of this.remotes.values()) disposeObject(remote.root);
    this.remotes.clear();
  }

  // Leave the room promptly when the tab navigates away (e.g. into a wormhole),
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
