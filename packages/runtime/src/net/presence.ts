import { CanvasTexture, Group, Mesh, MeshBasicMaterial, Sprite, SpriteMaterial, Vector3, type Object3D, type Scene } from 'three';
import { Footsteps } from '../audio/footsteps.js';
import { parseAvatarShare, type SignedAvatarShare } from '../avatar/descriptor.js';
import { loadAvatarModel, type LoadedAvatar } from '../avatar/loader.js';
import { animateDefaultAvatar, createDefaultAvatar, setAvatarColor, setAvatarExpression } from '../player/avatar.js';
import { setFigureStroke } from '../player/stroke.js';
import type { NetworkAdapter, PeerBody, PlayerState, WorldMeshHandle } from '../types.js';
import { isRoomFullSignal, probeRoomFull } from './roomFull.js';

/** The relay WorldMesh hosts (workers/presence). Worlds can point at their own. */
export const DEFAULT_PRESENCE_SERVER = 'wss://relay.worldmesh.net';

export interface PresenceOptions {
  /** Full WebSocket URL of the room, e.g. `wss://relay.example/world`. */
  url: string;
  scene: Scene;
  /** Players in the room including this one, or null while disconnected. */
  onCount?: (count: number | null) => void;
  getName?: () => string | null;
  /** Made-up name shown instead of the username in private mode. */
  getAlias?: () => string | null;
  /** Body colour ('#rrggbb') everyone else draws this visitor in, or null for the default. */
  getColor?: () => string | null;
  /**
   * The avatar everyone else should see this visitor wearing: the link the hub
   * signed for it (`descriptor.share`), or null for the default body.
   */
  getAvatar?: () => SharedAvatar | null;
  /**
   * Whether a link someone else sent was signed by the hub (createShareVerifier).
   * Models are downloaded only when it says yes; without it, everyone else is
   * drawn in the default body. Throwing means it cannot tell right now (the
   * hub's key did not load): the link is checked again a minute later.
   */
  verifyAvatar?: (share: SharedAvatar) => Promise<boolean>;
  /** Draw other people in the avatars they wear. Defaults to true. */
  showAvatars?: boolean;
  /** Largest avatar model downloaded for someone else. Defaults to 40 MB. */
  maxAvatarBytes?: number;
  /**
   * Someone new just started walking here, first seen at (x, z). Not called
   * for the people already in the room when this visitor joins.
   */
  onArrive?: (x: number, z: number) => void;
  /** Called with each remote figure as it is made, already outlined. */
  onFigure?: (root: Object3D) => void;
  /**
   * Someone in the room left, last seen at (x, z). Return true to keep their
   * figure in the scene a little longer (to finish an exit effect); hand it
   * back with `dropFigure` when done. Otherwise it is removed straight away.
   */
  onDepart?: (x: number, z: number, root: Object3D) => boolean | void;
  /**
   * Where this visitor is listening from. When set, everyone else's footsteps,
   * jumps and landings are heard, fading with distance and silent far off.
   */
  listener?: () => Vector3 | null;
  /**
   * The relay refused this join because the room is full. Not used for
   * ordinary disconnects — those still reconnect in the background.
   */
  onFull?: (full: boolean) => void;
  /**
   * Shared state of something in the room changed: a lift, a door. Called
   * for every write in the order the relay took them, this visitor's own
   * included (`self`), and for the room's remembered state on joining, with
   * how old it is in seconds (`age`, 0 for live writes).
   */
  onShared?: (key: string, value: Record<string, number>, info: { self: boolean; age: number }) => void;
  /**
   * Adjust where a remote figure is drawn this frame, after it eased toward
   * its last reported spot. Lets a world keep someone standing on a moving
   * platform, which they reported a moment ago from a little lower down.
   */
  place?: (position: Vector3, grounded: boolean) => void;
}

/** An avatar as it goes to everyone else in the room: a link the hub signed. */
export type SharedAvatar = SignedAvatarShare;

/** How often the local position goes out, per second. */
const SEND_RATE = 10;
/** The relay takes one avatar change a second per peer; stay under it. */
const AVATAR_SEND_MS = 1200;
/** Leeway for clocks that are a little off when checking a link's expiry. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** Resend at least this often while standing still, so late joiners see us. */
const HEARTBEAT_MS = 3000;
const MAX_BACKOFF_MS = 30_000;

interface Remote {
  /** Holds the body, name tag and bubble; moved and turned as one. */
  root: Object3D;
  /** The default figure, hidden while an avatar of theirs is shown. */
  body: Object3D;
  /** The avatar they wear, once downloaded. */
  external: LoadedAvatar | null;
  /** Id of the avatar they say they wear, '' for the default body. */
  avatarId: string;
  /** Their latest signed link to it. */
  avatarShare: SharedAvatar | null;
  /** Download in progress. */
  avatarLoad: AbortController | null;
  /** `id url` of the last download that failed, so it is not tried again. */
  avatarFailed: string;
  target: Vector3;
  targetYaw: number;
  yaw: number;
  /** Smoothed horizontal speed, estimated from how far the avatar moves. */
  speed: number;
  /** Their footsteps, jumps and landings, when this room hears them. */
  steps: Footsteps | null;
  /** Smoothed vertical speed, from how far the avatar rises or falls. */
  vertical: number;
  /** Standing on something (floor, platform, step) rather than in the air. */
  grounded: boolean;
  /** Body colour currently applied, '' for the default. */
  color: string;
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
  /** Body colour, '#rrggbb'; '' or absent for the default. */
  k?: string;
  /** The avatar they wear (welcome only). */
  v?: WireAvatar;
}

/** An avatar on the wire: a signed link (SignedAvatarShare). No `u` means the default body. */
interface WireAvatar {
  u?: unknown;
  f?: unknown;
  i?: unknown;
  x?: unknown;
  s?: unknown;
}

type ServerMessage =
  | { t: 'welcome'; id: string; peers: (PeerState & { id: string })[]; objects?: { k: string; v: unknown; ms: number }[] }
  | ({ t: 'v'; id: string } & WireAvatar)
  | { t: 'o'; id: string; k: string; v: unknown }
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
  private welcomed = false;
  private full = false;
  private probeId = 0;
  /** This connection has sent a position, so the relay will take an avatar. */
  private stateSent = false;
  /** `id url` of the avatar the relay last heard from us; null before anything was sent. */
  private avatarSent: string | null = null;
  private avatarSentAt = 0;
  /** Avatars heard for someone not drawn yet. */
  private pendingAvatars = new Map<string, WireAvatar>();
  /** One avatar download at a time, so a busy room does not stall the page. */
  private avatarQueue: Promise<void> = Promise.resolve();
  /** Tidies up an avatar left on a figure that is kept after its owner left. */
  private keptAvatars = new WeakMap<Object3D, LoadedAvatar>();

  readonly url: string;
  private onCount: (count: number | null) => void;
  private onFull: (full: boolean) => void;
  private getName: () => string | null;
  private getAlias: () => string | null;
  private getColor: () => string | null;
  private getAvatar: () => SharedAvatar | null;
  private showAvatars: boolean;
  private verifyAvatar: ((share: SharedAvatar) => Promise<boolean>) | null;
  private maxAvatarBytes: number | undefined;
  private onArrive: (x: number, z: number) => void;
  private onFigure: (root: Object3D) => void;
  private onDepart: NonNullable<PresenceOptions['onDepart']>;
  private listener: (() => Vector3 | null) | null;
  private onShared: NonNullable<PresenceOptions['onShared']>;
  private place: PresenceOptions['place'];

  constructor(options: PresenceOptions) {
    this.url = options.url;
    this.onCount = options.onCount ?? (() => {});
    this.onFull = options.onFull ?? (() => {});
    this.getName = options.getName ?? (() => null);
    this.getAlias = options.getAlias ?? (() => null);
    this.getColor = options.getColor ?? (() => null);
    this.getAvatar = options.getAvatar ?? (() => null);
    this.showAvatars = options.showAvatars !== false;
    this.verifyAvatar = options.verifyAvatar ?? null;
    this.maxAvatarBytes = options.maxAvatarBytes;
    this.onArrive = options.onArrive ?? (() => {});
    this.onFigure = options.onFigure ?? (() => {});
    this.onDepart = options.onDepart ?? (() => {});
    this.listener = options.listener ?? null;
    this.onShared = options.onShared ?? (() => {});
    this.place = options.place;
    this.group.name = 'worldmesh:remote-players';
    options.scene.add(this.group);
  }

  /** Late-bind the full-room overlay (createWorldMesh wires this after constructing Presence). */
  setOnFull(handler: (full: boolean) => void): void {
    this.onFull = handler;
    if (this.full) handler(true);
  }

  attach(world: WorldMeshHandle): void {
    this.unsubscribe = world.on('update', ({ dt, state }) => {
      this.sendLocalState(state);
      this.sendAvatar();
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
    const payload = JSON.stringify({ t: 's', p: [round(x), round(y), round(z)], r: round(state.facing), e: state.expression, n: this.getName() ?? '', a: this.getAlias() ?? '', k: this.getColor() ?? '', g: state.onGround || state.flying ? 1 : 0 });
    if (payload === this.lastPayload && now - this.lastSent < HEARTBEAT_MS) return;

    socket.send(payload);
    this.lastPayload = payload;
    this.lastSent = now;
    this.stateSent = true;
  }

  /**
   * Tell the room which avatar this visitor wears, whenever that (or its link)
   * changes. The relay keeps it for whoever joins later.
   */
  private sendAvatar(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.selfId || !this.stateSent) return;
    const avatar = parseAvatarShare(this.getAvatar());
    const key = avatar ? `${avatar.i} ${avatar.u} ${avatar.x}` : '';
    // Nothing to say on a fresh connection when there is no avatar.
    if (key === (this.avatarSent ?? '')) return;
    const now = performance.now();
    if (now - this.avatarSentAt < AVATAR_SEND_MS) return;
    socket.send(JSON.stringify(avatar ? { t: 'v', u: avatar.u, f: avatar.f, i: avatar.i, x: avatar.x, s: avatar.s } : { t: 'v' }));
    this.avatarSent = key;
    this.avatarSentAt = now;
  }

  /** Say something. Everyone else gets a bubble; this client draws its own. */
  say(text: string): void {
    const socket = this.socket;
    const line = text.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
    if (!line || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ t: 'c', m: line }));
  }

  /**
   * Set shared state everyone in the room sees, e.g. where a lift is going.
   * Values are flat objects of numbers. The write comes back through
   * `onShared` like everyone else's. False when not connected.
   */
  share(key: string, value: Record<string, number>): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.selfId) return false;
    socket.send(JSON.stringify({ t: 'o', k: key, v: value }));
    return true;
  }

  /** Remove a figure kept by `onDepart` once its exit is over. */
  dropFigure(root: Object3D): void {
    const external = this.keptAvatars.get(root);
    this.keptAvatars.delete(root);
    if (external) {
      external.object.removeFromParent();
      external.dispose();
    }
    disposeObject(root);
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
      this.place?.(remote.root.position, remote.grounded);

      let delta = remote.targetYaw - remote.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      remote.yaw += delta * blend;
      remote.root.rotation.y = remote.yaw;

      const moved = Math.hypot(remote.root.position.x - before.x, remote.root.position.z - before.z);
      remote.speed += (moved / Math.max(dt, 1e-4) - remote.speed) * blend;
      const motion = { dt, speed: remote.speed, grounded: remote.grounded };
      let footfall: boolean | null = null;
      if (remote.external) remote.external.animate(motion);
      else footfall = animateDefaultAvatar(remote.body, motion);
      if (remote.steps) {
        remote.vertical = (remote.root.position.y - before.y) / Math.max(dt, 1e-4);
        remote.steps.loudness = earshot(this.listener?.() ?? null, remote.root.position);
        remote.steps.update(dt, remote.speed, remote.grounded, footfall, remote.vertical);
      }

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
    this.probeId += 1;
    this.leaveFull();
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
    this.welcomed = false;

    listenForHandshakeRefuse(socket, (signal) => {
      if (this.socket !== socket || this.welcomed) return;
      if (isRoomFullSignal(signal)) this.enterFull();
    });

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

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      const welcomed = this.welcomed;
      this.socket = null;
      this.selfId = null;
      this.welcomed = false;
      this.clearRemotes();
      this.onCount(null);
      if (this.full) return;
      if (welcomed) {
        this.scheduleReconnect();
        return;
      }
      if (isRoomFullSignal({ code: event.code, reason: event.reason })) {
        this.enterFull();
        return;
      }
      void this.classifyFailedJoin();
    });
  }

  private disconnect(): void {
    this.probeId += 1;
    const socket = this.socket;
    this.socket = null;
    this.selfId = null;
    socket?.close(1000, 'bye');
    this.clearRemotes();
    this.onCount(null);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.full) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private enterFull(): void {
    if (this.full) return;
    this.full = true;
    window.clearTimeout(this.reconnectTimer);
    this.probeId += 1;
    const socket = this.socket;
    this.socket = null;
    this.selfId = null;
    this.welcomed = false;
    socket?.close(1000, 'full');
    this.clearRemotes();
    this.onCount(null);
    this.onFull(true);
  }

  private leaveFull(): void {
    if (!this.full) return;
    this.full = false;
    this.onFull(false);
  }

  /** Browser handshakes hide 503; confirm via HTTP before treating this as a network blip. */
  private async classifyFailedJoin(): Promise<void> {
    const id = ++this.probeId;
    const full = await probeRoomFull(this.url);
    if (id !== this.probeId || this.closed || this.socket || this.full) return;
    if (full) this.enterFull();
    else this.scheduleReconnect();
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        this.selfId = message.id;
        this.welcomed = true;
        this.backoff = 1000;
        this.lastPayload = '';
        this.lastSent = 0;
        this.stateSent = false;
        this.avatarSent = null;
        this.avatarSentAt = 0;
        this.leaveFull();
        for (const peer of message.peers) {
          if (peer.v) this.pendingAvatars.set(peer.id, peer.v);
          this.upsert(peer.id, peer, true);
        }
        for (const object of message.objects ?? []) this.shared(object.k, object.v, false, object.ms / 1000);
        break;
      case 'o':
        this.shared(message.k, message.v, message.id === this.selfId, 0);
        break;
      case 's':
        if (message.id !== this.selfId) this.upsert(message.id, message, false);
        break;
      case 'v': {
        if (message.id === this.selfId || typeof message.id !== 'string') break;
        const remote = this.remotes.get(message.id);
        if (remote) this.wear(remote, message);
        else this.pendingAvatars.set(message.id, message);
        break;
      }
      case 'c': {
        const remote = message.id === this.selfId ? undefined : this.remotes.get(message.id);
        if (remote && typeof message.m === 'string') showBubble(remote, message.m);
        break;
      }
      case 'leave': {
        const remote = this.remotes.get(message.id);
        if (remote) {
          const kept = this.onDepart(remote.root.position.x, remote.root.position.z, remote.root) === true;
          remote.avatarLoad?.abort();
          remote.avatarLoad = null;
          if (kept) {
            dropBubble(remote);
            if (remote.external) this.keptAvatars.set(remote.root, remote.external);
          } else disposeRemote(remote);
        }
        this.remotes.delete(message.id);
        this.pendingAvatars.delete(message.id);
        break;
      }
    }
    this.onCount(this.remotes.size + 1);
  }

  private shared(key: unknown, value: unknown, self: boolean, age: number): void {
    if (typeof key !== 'string' || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const numbers: Record<string, number> = {};
    for (const [name, v] of Object.entries(value)) if (typeof v === 'number' && Number.isFinite(v)) numbers[name] = v;
    this.onShared(key, numbers, { self, age: Number.isFinite(age) ? Math.max(0, age) : 0 });
  }

  private upsert(id: string, state: PeerState, snap: boolean): void {
    const { p, r: yaw, e: expression, g } = state;
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite) || !Number.isFinite(yaw)) return;
    const label = nameLabel(state.n, state.a);

    let remote = this.remotes.get(id);
    if (!remote) {
      const root = new Group();
      root.name = 'worldmesh:remote-player';
      const body = createDefaultAvatar();
      root.add(body);
      const tag = createNameTag(GUEST);
      tag.position.y = TAG_HEIGHT;
      root.add(tag);
      setFigureStroke(root, true);
      this.onFigure(root);
      this.group.add(root);
      remote = {
        root,
        body,
        external: null,
        avatarId: '',
        avatarShare: null,
        avatarLoad: null,
        avatarFailed: '',
        target: new Vector3(p[0], p[1], p[2]),
        targetYaw: yaw,
        yaw,
        speed: 0,
        steps: this.listener ? new Footsteps() : null,
        vertical: 0,
        grounded: true,
        color: '',
        label: GUEST,
        tag,
        appear: 0,
        bubble: null,
        bubbleLeft: 0,
      };
      this.remotes.set(id, remote);
      setFigureOpacity(root, 0);
      const pending = this.pendingAvatars.get(id);
      this.pendingAvatars.delete(id);
      if (pending) this.wear(remote, pending);
      if (!snap) this.onArrive(p[0], p[2]);
      snap = true;
    }
    // Peers that do not say whether they are grounded count as standing when
    // their height holds still, so a raised floor like the spawn platform
    // does not leave them in the jump pose.
    remote.grounded = g === 0 || g === 1 ? g === 1 : p[1] < 0.05 || Math.abs(p[1] - remote.target.y) < GROUND_HOLD;
    remote.target.set(p[0], p[1], p[2]);
    remote.targetYaw = yaw;
    if (typeof expression === 'string') setAvatarExpression(remote.body, expression);
    const color = typeof state.k === 'string' && COLOR.test(state.k) ? state.k.toLowerCase() : '';
    if (color !== remote.color) {
      remote.color = color;
      setAvatarColor(remote.body, color || DEFAULT_COLOR);
    }
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
    for (const remote of this.remotes.values()) disposeRemote(remote);
    this.remotes.clear();
    this.pendingAvatars.clear();
  }

  /**
   * Show the avatar someone says they wear, or their default body again.
   * A new link to the same avatar only replaces the link; it is not reloaded.
   */
  private wear(remote: Remote, avatar: WireAvatar): void {
    const wanted = this.showAvatars && this.verifyAvatar ? parseAvatarShare(avatar) : null;
    if (!wanted) {
      if (!remote.avatarId) return;
      remote.avatarId = '';
      remote.avatarShare = null;
      remote.avatarLoad?.abort();
      remote.avatarLoad = null;
      takeOffAvatar(remote);
      return;
    }
    const sameAvatar = wanted.i === remote.avatarId;
    remote.avatarShare = wanted;
    if (sameAvatar && (remote.external || remote.avatarLoad)) return;
    if (remote.avatarFailed === `${wanted.i} ${wanted.u} ${wanted.x}`) return;
    remote.avatarId = wanted.i;
    remote.avatarLoad?.abort();
    const load = (remote.avatarLoad = new AbortController());
    this.avatarQueue = this.avatarQueue.then(() => this.download(remote, load));
  }

  private async download(remote: Remote, load: AbortController): Promise<void> {
    const share = remote.avatarShare;
    if (load.signal.aborted || !share) return;
    const id = share.i;
    const failed = (reason: unknown) => {
      remote.avatarFailed = `${share.i} ${share.u} ${share.x}`;
      console.warn('[worldmesh] Not showing another player’s avatar; showing the default body.', reason);
      if (remote.avatarLoad === load) remote.avatarLoad = null;
    };
    // Only links the hub signed, and not ones that ran out long ago.
    if (share.x * 1000 < Date.now() - CLOCK_SKEW_MS) return failed('its link has expired');
    let vouched = false;
    try {
      vouched = !!this.verifyAvatar && (await this.verifyAvatar(share));
    } catch {
      // Could not tell just now (the hub's key did not load): not a bad link, so check again later.
      if (!load.signal.aborted) this.retryLater(remote, load);
      return;
    }
    if (load.signal.aborted) return;
    if (!vouched) return failed('its link is not signed by the hub');
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      load.abort();
    }, AVATAR_TIMEOUT_MS);
    try {
      const loaded = await loadAvatarModel(
        { provider: 'peer', avatarId: id, name: null, thumbnail: null, format: share.f, modelUrl: share.u, expiresAt: null, sourceUrl: null },
        { height: BODY_HEIGHT, maxBytes: this.maxAvatarBytes, signal: load.signal },
      );
      if (load.signal.aborted || remote.avatarId !== id) {
        loaded.dispose();
        return;
      }
      takeOffAvatar(remote);
      loaded.object.userData[EXTERNAL_KEY] = true;
      remote.root.add(loaded.object);
      remote.body.visible = false;
      remote.external = loaded;
    } catch (error) {
      if (load.signal.aborted && !timedOut) return;
      remote.avatarFailed = `${share.i} ${share.u} ${share.x}`;
      console.warn('[worldmesh] Could not load another player’s avatar; showing the default body.', error);
    } finally {
      window.clearTimeout(timer);
      if (remote.avatarLoad === load) remote.avatarLoad = null;
    }
  }

  /**
   * Download their avatar again in a while, with whatever link they sent by
   * then. Called off when the download is (they left or changed avatar).
   */
  private retryLater(remote: Remote, load: AbortController): void {
    const timer = window.setTimeout(() => {
      if (load.signal.aborted || remote.avatarLoad !== load) return;
      this.avatarQueue = this.avatarQueue.then(() => this.download(remote, load));
    }, AVATAR_RETRY_MS);
    load.signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true });
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

/** Give up on someone else's avatar download after this long. */
const AVATAR_TIMEOUT_MS = 60_000;
/** Check someone's link again after this long when the hub's key could not be had. */
const AVATAR_RETRY_MS = 60_000;
/** Marks the root of a downloaded avatar on a remote figure. */
const EXTERNAL_KEY = 'worldmeshExternal';

/** Back to the default body. */
function takeOffAvatar(remote: Remote): void {
  const external = remote.external;
  if (!external) return;
  external.object.removeFromParent();
  external.dispose();
  remote.external = null;
  remote.body.visible = true;
}

function disposeRemote(remote: Remote): void {
  remote.avatarLoad?.abort();
  remote.avatarLoad = null;
  takeOffAvatar(remote);
  disposeObject(remote.root);
}

/** Every object under `root`, except inside downloaded avatars, whose own materials are left as they are. */
function eachOwnPart(root: Object3D, visit: (child: Object3D) => void): void {
  visit(root);
  for (const child of root.children) {
    if (child.userData[EXTERNAL_KEY] === true) continue;
    eachOwnPart(child, visit);
  }
}

/**
 * Node's `ws` package emits `unexpected-response` with the HTTP status when
 * the upgrade is refused. Browsers only get a generic `error` / close 1006.
 */
function listenForHandshakeRefuse(
  socket: WebSocket,
  onRefuse: (signal: { status?: number; message?: string; body?: string }) => void,
): void {
  socket.addEventListener('error', (event) => {
    const err = event as ErrorEvent & { error?: { message?: string } };
    const message = err.message || err.error?.message;
    if (isRoomFullSignal({ message })) onRefuse({ message });
  });
  const nodeSocket = socket as WebSocket & {
    on?(event: string, listener: (...args: unknown[]) => void): void;
  };
  nodeSocket.on?.('unexpected-response', (...args: unknown[]) => {
    const res = args[1] as NodeHandshakeResponse | undefined;
    if (!res) return;
    const chunks: Uint8Array[] = [];
    res.on?.('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    });
    res.on?.('end', () => {
      onRefuse({ status: res.statusCode, body: new TextDecoder().decode(concatBytes(chunks)) });
    });
    if (!res.on) onRefuse({ status: res.statusCode });
  });
}

interface NodeHandshakeResponse {
  statusCode?: number;
  on?(event: string, listener: (chunk: string | Uint8Array) => void): void;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** How long a newly appeared figure takes to go from transparent to opaque. */
const APPEAR_FADE = 0.55;

const GUEST = 'Guest';

/** What a body colour must look like on the wire. */
const COLOR = /^#[0-9a-f]{6}$/i;
/** The default avatar's own colour, for a peer that goes back to it. */
const DEFAULT_COLOR = '#ffffff';

/** Ease every mesh on an avatar toward a shared opacity. */
function setFigureOpacity(root: Object3D, amount: number): void {
  const solid = amount >= 0.999;
  let outlined = false;
  eachOwnPart(root, (child) => {
    if (child instanceof Mesh && child.userData.stroke === true) outlined = true;
  });
  eachOwnPart(root, (child) => {
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

/** Footsteps are heard this far away at most, in metres. */
const EARSHOT = 30;

/** How loud someone at `source` is to a listener: full beside them, half at 8 m, nothing past earshot. */
function earshot(listener: Vector3 | null, source: Vector3): number {
  if (!listener) return 0;
  const distance = listener.distanceTo(source);
  if (distance >= EARSHOT) return 0;
  // Eased to zero at the edge so walking out of earshot does not cut a step off.
  const edge = 1 - distance / EARSHOT;
  return (1 / (1 + distance / 8)) * Math.min(1, edge * 4);
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
