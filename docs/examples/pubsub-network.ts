/**
 * A NetworkAdapter for a pub/sub WebSocket backend: a world's own multiplayer
 * instead of the WorldMesh presence relay. See "Your own network layer" in
 * docs/compatibility.md, and pubsub-server.mjs for a server it talks to.
 *
 *   createWorldMesh({ scene, camera, renderer, avatar: { source: 'worldmesh' },
 *     network: new PubSubNetwork('wss://rooms.example/forest') });
 *
 * On the wire, as JSON. The server adds `from`, the sender's id, to everything
 * it passes on, and says `join` and `leave` itself:
 *
 *   { t: 'pose', p: [x, y, z], r: facing, e: expression, g: 1 | 0 }
 *   { t: 'avatar', share: SignedAvatarShare | null }
 *   { t: 'join', from }   { t: 'leave', from }
 *
 * Whatever touches `socket` is the transport; the rest is the same on Nakama,
 * Colyseus, PartyKit, Supabase Realtime or Ably.
 */
import {
  animateDefaultAvatar,
  createDefaultAvatar,
  createNameTag,
  createShareVerifier,
  easeYaw,
  loadAvatarModel,
  parseAvatarShare,
  setAvatarExpression,
  setFigureStroke,
  type LoadedAvatar,
  type NetworkAdapter,
  type PeerBody,
  type PlayerState,
  type SignedAvatarShare,
  type WorldMeshHandle,
} from '@worldmesh/runtime';
import { Group, Mesh, Sprite, Vector3 } from 'three';

/** Downloads only avatar links this hub signed. Use the hub in your `avatar.hubUrl`. */
const verifyAvatar = createShareVerifier('https://worldmesh.net/');

type Message = Record<string, unknown>;

interface Peer {
  root: Group; // body and name tag, moved and turned as one
  body: Group; // the default figure, hidden while their own avatar shows
  avatar: LoadedAvatar | null;
  avatarId: string; // '' for the default body
  target: Vector3; // where they last said they were
  targetYaw: number;
  yaw: number;
  speed: number;
  grounded: boolean;
}

export class PubSubNetwork implements NetworkAdapter {
  private world: WorldMeshHandle | null = null;
  private socket: WebSocket | null = null;
  private peers = new Map<string, Peer>();
  private group = new Group();
  private stopUpdates: (() => void) | null = null;
  private lastSent = 0;
  private lastPose = '';
  private lastAvatar = '';
  private closed = false;

  constructor(private readonly url: string) {}

  attach(world: WorldMeshHandle): void {
    this.world = world;
    world.scene.add(this.group);
    // Every frame, after movement: the local player's state.
    this.stopUpdates = world.on('update', ({ dt, state }) => {
      this.sendLocalState(state);
      this.draw(dt);
    });
    window.addEventListener('pagehide', this.leaveNow);
    this.connect();
  }

  detach(): void {
    this.closed = true;
    this.stopUpdates?.();
    window.removeEventListener('pagehide', this.leaveNow);
    this.socket?.close();
    for (const id of [...this.peers.keys()]) this.remove(id);
    this.group.removeFromParent();
  }

  /** The runtime stops the visitor at everyone else's edge. */
  bodies(): PeerBody[] {
    return [...this.peers.values()].map(({ root: { position: p } }) => ({ x: p.x, y: p.y, z: p.z, radius: 0.35, height: 1.8 }));
  }

  // Transport: the part that changes with the backend.

  private connect(): void {
    const socket = (this.socket = new WebSocket(this.url));
    socket.onopen = () => {
      this.lastPose = '';
      this.lastAvatar = '';
    };
    socket.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message && typeof message === 'object') this.receive(message as Message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const id of [...this.peers.keys()]) this.remove(id);
      // Single-player until the server is back.
      if (!this.closed) setTimeout(() => this.connect(), 5000);
    };
  }

  /** Leave at once when the page goes (through a portal, say), not when the server notices. */
  private leaveNow = (): void => this.socket?.close();

  // Out: where this visitor is, and what they wear.

  sendLocalState(state: PlayerState): void {
    const socket = this.socket;
    const now = performance.now();
    if (socket?.readyState !== WebSocket.OPEN || now - this.lastSent < 100) return; // 10 a second, like the relay
    this.lastSent = now;
    const [x, y, z] = state.position;
    const pose = JSON.stringify({ t: 'pose', p: [round(x), round(y), round(z)], r: round(state.facing), e: state.expression, g: state.onGround || state.flying ? 1 : 0 });
    // Standing still says nothing. Someone who joins later is answered in `receive`.
    if (pose !== this.lastPose) socket.send(pose);
    this.lastPose = pose;
    // The hub-signed link to their avatar, which the runtime renews before it expires.
    const share = this.world?.getSharedAvatar() ?? null;
    if ((share?.s ?? '') !== this.lastAvatar) socket.send(JSON.stringify({ t: 'avatar', share }));
    this.lastAvatar = share?.s ?? '';
  }

  // In: `from` is the sender's id, which the server adds.

  private receive(message: Message): void {
    const id = message.from;
    if (typeof id !== 'string') return;
    if (message.t === 'join') {
      // Someone new: say where we are and what we wear on the next frame.
      this.lastPose = '';
      this.lastAvatar = '';
    } else if (message.t === 'pose') this.pose(id, message);
    else if (message.t === 'avatar') void this.wear(id, parseAvatarShare(message.share));
    else if (message.t === 'leave') this.remove(id);
  }

  private pose(id: string, { p, r, e, g }: Message): void {
    if (!isVec3(p) || typeof r !== 'number' || !Number.isFinite(r)) return;
    const known = this.peers.get(id);
    const peer = known ?? this.add(id);
    peer.target.set(...p);
    peer.targetYaw = r;
    peer.grounded = g === 1;
    if (typeof e === 'string') setAvatarExpression(peer.body, e);
    // New here, or teleported: appear there instead of sliding across.
    if (!known || peer.root.position.distanceTo(peer.target) > 6) {
      peer.root.position.copy(peer.target);
      peer.yaw = r;
    }
  }

  /** Someone new, in the default figure with a name tag until their avatar loads. */
  private add(id: string): Peer {
    const root = new Group();
    const body = createDefaultAvatar();
    const tag = createNameTag('Guest');
    tag.position.y = 2.15;
    root.add(body, tag);
    setFigureStroke(root, true);
    this.group.add(root);
    const peer: Peer = { root, body, avatar: null, avatarId: '', target: new Vector3(), targetYaw: 0, yaw: 0, speed: 0, grounded: true };
    this.peers.set(id, peer);
    return peer;
  }

  /** Ease everyone toward where they last said they were, and walk them there. */
  private draw(dt: number): void {
    const blend = 1 - Math.exp(-dt * 10);
    for (const peer of this.peers.values()) {
      const { position } = peer.root;
      const [x, z] = [position.x, position.z];
      position.lerp(peer.target, blend);
      peer.yaw = easeYaw(peer.yaw, peer.targetYaw, blend);
      peer.root.rotation.y = peer.yaw;
      peer.speed += (Math.hypot(position.x - x, position.z - z) / Math.max(dt, 1e-4) - peer.speed) * blend;
      const motion = { dt, speed: peer.speed, grounded: peer.grounded };
      if (peer.avatar) peer.avatar.animate(motion);
      else animateDefaultAvatar(peer.body, motion);
    }
  }

  /**
   * Show the avatar someone says they wear. Only links the hub signed are
   * downloaded: a made-up link could point at a server that logs the IP
   * address of everyone in the room.
   */
  private async wear(id: string, share: SignedAvatarShare | null): Promise<void> {
    const peer = this.peers.get(id);
    if (!peer || (share?.i ?? '') === peer.avatarId) return;
    peer.avatarId = share?.i ?? '';
    takeOff(peer);
    if (!share || share.x * 1000 < Date.now() - 5 * 60_000) return; // expired, with 5 minutes for clock skew
    if (!(await verifyAvatar(share).catch(() => false))) return;
    const world = this.world;
    const avatar = await loadAvatarModel(
      { provider: 'peer', avatarId: share.i, name: null, thumbnail: null, format: share.f, modelUrl: share.u, expiresAt: null, sourceUrl: null },
      {
        height: 1.8,
        maxBytes: 40 * 1024 * 1024,
        // Readies it for drawing a bit at a time, so it does not freeze a frame when it appears.
        warmUp: world ? { renderer: world.renderer, scene: world.scene, camera: world.camera } : undefined,
      },
    ).catch(() => null);
    if (!avatar) return;
    // They left, or changed avatar, while it downloaded.
    if (this.peers.get(id) !== peer || peer.avatarId !== share.i) return avatar.dispose();
    peer.root.add(avatar.object);
    peer.body.visible = false;
    peer.avatar = avatar;
  }

  private remove(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    takeOff(peer);
    peer.root.traverse((child) => {
      if (child instanceof Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      } else if (child instanceof Mesh) {
        child.geometry.dispose();
        for (const material of [child.material].flat()) material.dispose();
      }
    });
    peer.root.removeFromParent();
  }
}

function takeOff(peer: Peer): void {
  peer.avatar?.object.removeFromParent();
  peer.avatar?.dispose();
  peer.avatar = null;
  peer.body.visible = true;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function isVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}
