import { Euler, Group, PerspectiveCamera, Plane, Quaternion, Vector2, Vector3 } from 'three';
import { resolveAbilities } from '../abilities/abilities.js';
import { parseAvatarDescriptor, type AvatarDescriptor } from '../avatar/descriptor.js';
import { getAvatarTicket, resolveWorldMeshAvatar, setAvatarTicket, takeAvatarTicket } from '../avatar/handoff.js';
import { SharedAvatarLink, createShareVerifier } from '../avatar/share.js';
import { rememberView, takeViewHandoff } from '../camera/viewHandoff.js';
import { loadAvatarModel } from '../avatar/loader.js';
import { Footsteps } from '../audio/footsteps.js';
import { CameraRig } from '../camera/cameraRig.js';
import { LandingMarker } from '../camera/landingMarker.js';
import { Input } from '../controls/input.js';
import { CollisionWorld } from '../movement/collision.js';
import { MovementController } from '../movement/controller.js';
import { expressionForDigit, isAvatarExpression, setAvatarColor } from '../player/avatar.js';
import { Player } from '../player/player.js';
import { PortalManager, buildTravelUrl, type ResolvedPortal } from '../portals/portals.js';
import type {
  PlayerState,
  Vec3Tuple,
  ViewMode,
  WorldMeshEvents,
  WorldMeshHandle,
  WorldMeshOptions,
} from '../types.js';
import { Overlay } from '../ui/overlay.js';
import { isTouchDevice } from '../controls/touch.js';
import { immersiveVrSupported, requestImmersiveVr } from '../xr/session.js';
import { Emitter } from './events.js';
import { DEFAULT_PRESENCE_SERVER, Presence } from '../net/presence.js';
import { roomFullLabel } from '../net/roomFull.js';

/** Never simulate more than this per substep, so a stall cannot tunnel the player. */
const MAX_STEP = 1 / 60;
/** Never simulate more than this per frame, so a backgrounded tab does not catch up violently. */
const MAX_FRAME = 0.1;
const DEFAULT_HUB = 'https://worldmesh.net/';
/** Seconds to ease the field of view back to the world's own after taking over the hub's camera. */
const FOV_RETURN = 1.5;
/**
 * Set by a host that draws the world live in one of its doorways (Doorway,
 * docs/specs/doorway.md §3.1). The world only watches its room (everyone in
 * it is drawn, nobody sees the visitor), shows no UI, takes no input, and
 * draws only when the host sends a camera (`doorway:view`), from that camera
 * carried through the doorway onto its spawn point. When the visitor walks
 * through (`doorway:enter`), it takes over from their pose and joins the
 * room, without reloading (§4).
 */
export const DOORWAY_VIEW_PARAM = 'doorway-view';
/** Metres from the doorway back to the spawn point in a live view, and where a walk-in lands. */
const VIEW_SPAWN_BEHIND = 0.6;
/** Seconds a live view waits for the player to land at spawn before saying it is ready. */
const VIEW_SETTLE = 2;
/** The pre-Doorway names, still understood: `worldmesh:*` messages. */
const isDoorwayMessage = (data: unknown, name: string): boolean => {
  const type = (data as { type?: unknown } | null)?.type;
  return type === `doorway:${name}` || type === `worldmesh:${name}`;
};

/**
 * Turn an ordinary Three.js scene into a WorldMesh world.
 *
 * This is the whole compatibility surface: a world that can produce a scene,
 * a camera and a renderer gets the shared controls, all three camera modes, the
 * shared overlay and portals from one call.
 */
export function createWorldMesh(options: WorldMeshOptions): WorldMeshHandle {
  const { scene, camera, renderer } = options;
  // Always take an avatar handoff ticket out of the address bar, even if this
  // world shows no avatars: portals still carry it on to the next world.
  const avatarTicket = takeAvatarTicket();
  // A view the visitor picked here or in the world they came from wins over this world's default.
  const rememberedView = takeViewHandoff();
  const spawn = new Vector3(...(options.spawn ?? [0, 2, 0]));
  const abilities = resolveAbilities(options.abilities);

  // Before anything sizes the canvas: a live doorway view draws at 1×.
  /** Drawn live in a host's doorway, not walked into yet. */
  let viewing = isDoorwayViewRequest();
  /** Inside a host's page (in its doorway, or walked into from it): other pages open through the host. */
  const inHost = viewing;
  const height = options.player?.height ?? 1.8;
  const radius = options.player?.radius ?? 0.35;

  const collision = new CollisionWorld(options.colliders ?? [], options.groundLevel ?? 0);
  const events = new Emitter<WorldMeshEvents>();

  const vrEnabled = options.vr !== false;
  const overlay = new Overlay({
    ...options.ui,
    onEnter: (touch) => input.requestPointerLock(touch),
    onEnterVr: () => {
      void enterVR();
    },
    onInteract: () => {
      if (activePortal) {
        activatePortal(activePortal);
      } else {
        input.triggerAction('interact');
      }
    },
  });

  const input = new Input({
    element: renderer.domElement,
    keymap: options.keymap,
    moveBeforeLock: options.ui?.moveBeforeLock === true,
    onPointerLockChange: (locked) => {
      overlay.setLocked(locked);
      events.emit('pointer:lock', { locked });
    },
    onEscape: () => {
      if (overlay.isPaused()) {
        input.requestPointerLock();
        return true;
      }
      input.exitPointerLock();
      return false;
    },
  });

  const cameraRig = new CameraRig({ ...options.view, mode: rememberedView ?? options.view?.mode, camera, collision });
  const landingMarker = new LandingMarker();
  scene.add(landingMarker.root);
  const player = new Player({ ...options.player, height, radius });
  if (player.root) scene.add(player.root);

  const controller = new MovementController({
    input,
    collision,
    abilities,
    tuning: options.movement,
    height,
    radius,
    spawn,
  });

  const portals = new PortalManager(scene, options.portals);

  let running = false;
  let lastTime = 0;
  let elapsed = 0;
  let activePortal: ResolvedPortal | null = null;
  let disposed = false;
  const footsteps = options.footsteps ? new Footsteps() : null;
  let avatarDescriptor: AvatarDescriptor | null = null;
  let avatarLoad: AbortController | null = null;
  /** The avatar other players see this visitor in; its link is renewed through the hub when it expires. */
  const sharedAvatar = new SharedAvatarLink(
    options.avatar?.source === 'worldmesh'
      ? () => {
          const ticket = getAvatarTicket();
          const hubUrl = (options.avatar?.source === 'worldmesh' && options.avatar.hubUrl) || DEFAULT_HUB;
          return ticket ? resolveWorldMeshAvatar(hubUrl, ticket) : Promise.resolve(null);
        }
      : null,
  );
  let xrSession: XRSession | null = null;
  const xrOrigin = new Group();
  xrOrigin.name = 'worldmesh-xr-origin';
  const xrHeading = new Euler(0, 0, 0, 'YXZ');
  if (vrEnabled) {
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    scene.add(xrOrigin);
  }

  const handle: WorldMeshHandle = {
    scene,
    camera,
    renderer,
    abilities,
    avatar: player.root,
    get avatarDescriptor() {
      return avatarDescriptor;
    },

    start,
    stop,
    update,
    dispose,

    getState,
    setState,
    teleport,
    respawn: () => doRespawn('manual'),

    setViewMode,
    getViewMode: () => cameraRig.mode,
    getCameraDistance: () => cameraRig.distance,
    setCameraDistance: (distance) => {
      if (Number.isFinite(distance)) cameraRig.distance = Math.max(0.4, distance);
    },

    addPortal: (portal) => {
      portals.add(portal);
    },
    travelTo,
    releasePointer: () => input.release(),

    loadAvatar,
    clearAvatar,
    getSharedAvatar: () => sharedAvatar.get(),

    on: (event, fn) => events.on(event, fn),
    off: (event, fn) => events.off(event, fn),

    refreshColliders: () => collision.refresh(),

    enterVR,
    exitVR,
    isVR: () => renderer.xr.isPresenting,

  };

  applyViewVisibility();

  if (options.autoResize !== false) window.addEventListener('resize', handleResize);
  handleResize();

  if (options.autoStart !== false) start();

  let network: WorldMeshOptions['network'];
  /** Easing the field of view back to the world's own, after a walk-in took over the hub's. */
  let fovReturn: { from: number; to: number; t: number } | null = null;
  /** Live doorway view: said ready to the host, and drawn a view for it. */
  let viewReady = false;
  let viewFramed = false;
  const viewStart = performance.now();
  /** The host's latest view, not drawn yet. */
  let pendingView: DoorwayView | null = null;
  if (viewing) {
    serveDoorwayView();
    watchOnline();
  } else goOnline();

  if (!viewing) startAvatar();
  if (vrEnabled && !viewing) void offerVr();

  return handle;

  /**
   * Live doorway view: watch the room, so the people in it show through the
   * doorway, without joining it. Walked into, goOnline joins on the same
   * connection. A world's own network adapter waits for the walk-in.
   */
  function watchOnline(): void {
    if (options.network) return;
    network = createMultiplayer(true);
    network?.attach(handle);
  }

  function goOnline(): void {
    const watched = network instanceof Presence && network.watching ? network : null;
    if (!watched) network = options.network ?? createMultiplayer();
    if (network instanceof Presence) {
      const presence = network;
      presence.setOnFull((full) => {
        overlay.setRoomFull(full ? roomFullLabel(presence.url) : null, {
          onRetry: full ? () => presence.rejoin() : undefined,
        });
        if (full) input.exitPointerLock();
        events.emit('room:full', { full });
      });
    }
    if (watched) watched.join();
    else network?.attach(handle);
    const bodies = network?.bodies?.bind(network);
    if (bodies) controller.bodies = () => bodies();
  }

  /**
   * Drawn live in a host's doorway (DOORWAY_VIEW_PARAM): only watching, no overlay,
   * no input, no body of its own (the visitor's is in the host). The world
   * keeps running (water, animations) and draws, once a frame, the latest
   * view the host sent; none sent, nothing drawn. Ready once the player has
   * landed at spawn, so the first view doesn't sink.
   */
  function serveDoorwayView(): void {
    // Kept, out of sight: walked into, the world shows them again.
    injectDoorwayViewStyle();
    document.documentElement.classList.add(DOORWAY_VIEW_CLASS);
    applyViewVisibility();
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || disposed || !viewReady) return;
      const view = event.data as Partial<DoorwayView> & { type?: unknown };
      // Only the latest counts: a world slower than the host never falls behind.
      if (view?.type === 'doorway:view' && validDoorwayView(view)) pendingView = view;
      else if (isDoorwayMessage(event.data, 'enter')) {
        window.removeEventListener('message', onMessage);
        enterFromView(event.data);
      }
    };
    window.addEventListener('message', onMessage);
    awaitCharacter();
  }

  /**
   * Walked into from the doorway: the pose comes in the door's frame, like
   * the views, and lands the same way, on the spawn point beyond it. Then the
   * world is itself again: drawing on its own, its UI and the visitor's body
   * back, online. The host hears `doorway:entered` once a frame from there
   * is drawn.
   */
  function enterFromView(message: { url?: unknown; pose?: unknown }): void {
    const url = typeof message.url === 'string' ? message.url : null;
    try {
      if (url && new URL(url).origin === window.location.origin) window.history.replaceState(null, '', url);
    } catch {
      // Keep the view address.
    }
    if (disposed) return;
    takePose(poseFromDoor(message.pose));
    viewing = false;
    pendingView = null;
    document.documentElement.classList.remove(DOORWAY_VIEW_CLASS);
    handleResize();
    applyViewVisibility();
    input.requestPointerLock(isTouchDevice());
    window.addEventListener('message', onCarry);
    goOnline();
    requestAnimationFrame(() => requestAnimationFrame(() => window.parent.postMessage({ type: 'doorway:entered' }, '*')));
  }

  /** A pose in the door's frame (doorway:enter from a live view), in this world's coordinates; null if malformed. */
  function poseFromDoor(pose: unknown): unknown {
    const p = pose as Record<string, unknown> | null;
    const vec = (v: unknown): v is Vec3Tuple => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
    if (!p || !vec(p.position)) return null;
    const spawnYaw = cameraRig.yaw;
    viewTurn.setFromAxisAngle(UP, spawnYaw);
    viewThreshold.set(0, 0, VIEW_SPAWN_BEHIND).applyQuaternion(viewTurn).add(controller.position);
    const place = (v: Vec3Tuple) => new Vector3(...v).applyQuaternion(viewTurn).add(viewThreshold).toArray();
    const turn = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n + spawnYaw : n);
    return {
      ...p,
      position: place(p.position),
      velocity: vec(p.velocity) ? new Vector3(...p.velocity).applyQuaternion(viewTurn).toArray() : p.velocity,
      camera: vec(p.camera) ? place(p.camera) : p.camera,
      yaw: turn(p.yaw),
      facing: turn(p.facing),
    };
  }

  /** In the loop, instead of drawing: say ready once settled at spawn, then draw the latest view. */
  function stepDoorwayView(): void {
    if (!viewReady && (controller.onGround || performance.now() - viewStart > VIEW_SETTLE * 1000)) {
      viewReady = true;
      window.parent.postMessage({ type: 'doorway:view-ready' }, '*');
    }
    const view = pendingView;
    if (!view) return;
    pendingView = null;
    drawDoorwayView(view);
    if (!viewFramed) {
      viewFramed = true;
      window.parent.postMessage({ type: 'doorway:view-frame' }, '*');
    }
  }

  /**
   * One view: the host's camera, in the door's frame (threshold at the
   * origin, +Y up, −Z through the doorway), carried onto the spawn point
   * VIEW_SPAWN_BEHIND metres beyond it, facing the way the player does.
   * Only the doorway's part of the screen, and nothing on the host's side.
   */
  function drawDoorwayView(view: DoorwayView): void {
    const { width, height: viewHeight } = view.viewport;
    renderer.getSize(viewSize);
    if (viewSize.x !== width || viewSize.y !== viewHeight) renderer.setSize(width, viewHeight);
    if (camera instanceof PerspectiveCamera) {
      camera.fov = view.camera.fov;
      camera.aspect = width / viewHeight;
      camera.updateProjectionMatrix();
    }
    viewTurn.setFromAxisAngle(UP, cameraRig.yaw);
    viewThreshold.set(0, 0, VIEW_SPAWN_BEHIND).applyQuaternion(viewTurn).add(controller.position);
    camera.position.fromArray(view.camera.position).applyQuaternion(viewTurn).add(viewThreshold);
    camera.quaternion.copy(viewTurn).multiply(viewQuaternion.fromArray(view.camera.quaternion));
    camera.updateMatrixWorld();
    viewClip.setFromNormalAndCoplanarPoint(viewForward.set(0, 0, -1).applyQuaternion(viewTurn), viewThreshold);
    const worldPlanes = renderer.clippingPlanes;
    renderer.clippingPlanes = [...worldPlanes, viewClip];
    const [left, top, right, bottom] = view.rect;
    renderer.setScissorTest(true);
    renderer.setScissor(left, viewHeight - bottom, right - left, bottom - top);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
    renderer.clippingPlanes = worldPlanes;
  }

  /** The hub's joystick, still held as the visitor walked in, keeps them walking until it is let go. */
  function onCarry(event: MessageEvent): void {
    if (event.source !== window.parent || !isDoorwayMessage(event.data, 'carry')) return;
    input.carry(Number(event.data.x) || 0, Number(event.data.z) || 0);
    if (!event.data.x && !event.data.z) window.removeEventListener('message', onCarry);
  }

  /**
   * In a doorway: the host hands over the visitor's character while the world
   * still waits, so it is on screen from the first frame they walk in
   * (Doorway §6): `{ type: 'doorway:character', format, name, data }`, the
   * model file itself (nothing is fetched twice), or `data: null` for the
   * default body. Taken from any host, only if the world shows visitors'
   * characters at all. From this world's own hub (`avatar.hubUrl`), the
   * WorldMesh extras under `worldmesh` are used too: the Avatar Wallet
   * descriptor (for credits) and the handoff ticket for portals onwards. The
   * pre-Doorway `worldmesh:avatar` from the hub is still understood. Answers
   * `doorway:character-ready` (or `worldmesh:avatar-ready`).
   */
  function awaitCharacter(): void {
    const config = options.avatar;
    if (config?.source !== 'worldmesh') return;
    let hubOrigin: string;
    try {
      hubOrigin = new URL(config.hubUrl ?? DEFAULT_HUB).origin;
    } catch {
      return;
    }
    let latest = 0;
    window.addEventListener('message', async (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const message = event.data as Record<string, unknown> | null;
      const fromHub = event.origin === hubOrigin;
      const neutral = message?.type === 'doorway:character';
      if (!neutral && !(fromHub && message?.type === 'worldmesh:avatar')) return;
      const turn = ++latest;

      const extras = (neutral ? message.worldmesh : message) as { descriptor?: unknown; ticket?: unknown } | undefined;
      if (fromHub && typeof extras?.ticket === 'string') setAvatarTicket(extras.ticket);
      const data = message.data instanceof ArrayBuffer ? message.data : undefined;
      let descriptor = fromHub ? parseAvatarDescriptor(extras?.descriptor) : null;
      if (!descriptor && neutral && data && (message.format === 'vrm' || message.format === 'glb')) {
        descriptor = {
          provider: 'doorway',
          avatarId: '',
          name: typeof message.name === 'string' ? message.name.slice(0, 64) : null,
          thumbnail: null,
          format: message.format,
          // Never fetched: the file came with the message.
          modelUrl: '',
          expiresAt: null,
          sourceUrl: null,
        };
      }
      let loaded = false;
      if (descriptor) {
        loaded = await loadAvatar(descriptor, data);
      } else if (neutral ? message.data === null : extras?.descriptor === null) {
        // Back to the default body (private mode, or no character any more).
        clearAvatar();
      }
      if (turn !== latest || disposed) return;
      const answer = neutral ? 'doorway:character-ready' : 'worldmesh:avatar-ready';
      window.parent.postMessage({ type: answer, loaded }, event.origin);
    });
  }

  /** Where a hub had the visitor as they walked in, in this world's coordinates. Ignores anything malformed. */
  function takePose(pose: unknown): void {
    const p = pose as Partial<{
      position: Vec3Tuple;
      velocity: Vec3Tuple;
      camera: Vec3Tuple;
      mode: ViewMode;
      yaw: number;
      pitch: number;
      facing: number;
      fov: number;
      color: string;
    }> | null;
    const vec = (v: unknown): v is Vec3Tuple => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
    const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    if (!p || !vec(p.position)) return;
    controller.reset(new Vector3(...p.position));
    if (vec(p.velocity)) controller.velocity.set(...p.velocity);
    if (num(p.yaw)) cameraRig.yaw = p.yaw;
    if (num(p.pitch)) cameraRig.pitch = p.pitch;
    if (num(p.facing)) player.facing = p.facing;
    if (p.mode === 'first' || p.mode === 'third') setViewMode(p.mode);
    if (cameraRig.mode === 'third' && vec(p.camera)) {
      // Same boom as the hub's camera had, measured from this world's eyes; it eases back out from there.
      const eyes = new Vector3(...p.position).add(new Vector3(0, player.eyeHeight * (controller.height / height), 0));
      cameraRig.snapBoom(eyes.distanceTo(new Vector3(...p.camera)));
    }
    // The figure keeps the colour it had in the hub (the default body only).
    if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) && player.root && !avatarDescriptor) setAvatarColor(player.root, p.color);
    if (num(p.fov) && camera instanceof PerspectiveCamera && Math.abs(camera.fov - p.fov) > 0.01) {
      fovReturn = { from: p.fov, to: camera.fov, t: 0 };
      camera.fov = p.fov;
      camera.updateProjectionMatrix();
    }
  }

  /** Leave for another page; a world inside a host's page asks the host to go there instead. */
  function leaveFor(url: string): void {
    if (inHost) window.parent.postMessage({ type: 'doorway:navigate', url }, '*');
    else window.location.href = url;
  }

  /** Brings in the visitor's own avatar, if the world asked for one. The default body stays until it is ready. */
  function startAvatar(): void {
    const config = options.avatar;
    if (!config || !player.root) return;
    if (config.source === 'descriptor') {
      const descriptor = parseAvatarDescriptor(config.descriptor);
      if (descriptor) void loadAvatar(descriptor);
      else events.emit('avatar:error', { descriptor: null, error: new Error('Invalid avatar descriptor') });
      return;
    }
    if (config.source !== 'worldmesh' || !avatarTicket) return;
    resolveWorldMeshAvatar(config.hubUrl ?? DEFAULT_HUB, avatarTicket).then(
      (descriptor) => {
        if (descriptor && !disposed) void loadAvatar(descriptor);
      },
      (error) => events.emit('avatar:error', { descriptor: null, error }),
    );
  }

  async function loadAvatar(descriptor: AvatarDescriptor, data?: ArrayBuffer): Promise<boolean> {
    if (disposed || !player.root) return false;
    avatarLoad?.abort();
    const load = (avatarLoad = new AbortController());
    try {
      const loaded = await loadAvatarModel(descriptor, {
        height,
        maxBytes: options.avatar?.maxBytes,
        signal: load.signal,
        data,
        warmUp: { renderer, scene, camera },
      });
      if (disposed || load.signal.aborted) {
        loaded.dispose();
        return false;
      }
      if (!player.setExternalBody(loaded)) return false;
      avatarDescriptor = descriptor;
      sharedAvatar.set(descriptor);
      applyViewVisibility();
      events.emit('avatar:load', { descriptor });
      return true;
    } catch (error) {
      if (load.signal.aborted) return false;
      console.warn('[worldmesh] Could not load the avatar; keeping the default body.', error);
      events.emit('avatar:error', { descriptor, error });
      return false;
    } finally {
      if (avatarLoad === load) avatarLoad = null;
    }
  }

  function clearAvatar(): void {
    avatarLoad?.abort();
    player.clearExternalBody();
    avatarDescriptor = null;
    sharedAvatar.set(null);
  }

  function start(): void {
    if (running || disposed) return;
    running = true;
    lastTime = performance.now();
    // setAnimationLoop is the WebXR frame pump; it also drives the flat canvas.
    renderer.setAnimationLoop(frame);
  }

  function stop(): void {
    running = false;
    renderer.setAnimationLoop(null);
  }

  function frame(now: number): void {
    if (!running) return;
    const dt = Math.min((now - lastTime) / 1000, MAX_FRAME);
    lastTime = now;
    update(dt);
    options.onUpdate?.(dt, handle);
    if (fovReturn && camera instanceof PerspectiveCamera) {
      fovReturn.t = Math.min(1, fovReturn.t + dt / FOV_RETURN);
      const k = fovReturn.t * fovReturn.t * (3 - 2 * fovReturn.t);
      camera.fov = fovReturn.from + (fovReturn.to - fovReturn.from) * k;
      camera.updateProjectionMatrix();
      if (fovReturn.t >= 1) fovReturn = null;
    }
    // A live doorway view draws the host's latest camera instead (stepDoorwayView).
    // Drawing is what places things otherwise, and colliders need them placed.
    if (viewing) {
      scene.updateMatrixWorld();
      stepDoorwayView();
    } else {
      renderer.render(scene, camera);
    }
  }

  async function offerVr(): Promise<void> {
    if (disposed || !(await immersiveVrSupported())) return;
    overlay.setVrAvailable(true);
  }

  async function enterVR(): Promise<boolean> {
    if (!vrEnabled || disposed) return false;
    if (renderer.xr.isPresenting) return true;
    try {
      input.exitPointerLock();
      const session = await requestImmersiveVr(renderer);
      bindXrSession(session);
      return true;
    } catch (error) {
      console.warn('[worldmesh] Could not start VR.', error);
      return false;
    }
  }

  async function exitVR(): Promise<void> {
    if (!xrSession) return;
    try {
      await xrSession.end();
    } catch {
      unbindXrSession();
    }
  }

  function bindXrSession(session: XRSession): void {
    // The headset is the camera: no bird's-eye view in VR.
    if (cameraRig.mode === 'aerial') setViewMode(cameraRig.walkingMode);
    xrSession = session;
    input.setXrSession(session);
    if (camera.parent !== xrOrigin) xrOrigin.add(camera);
    overlay.setVrPresenting(true);
    applyViewVisibility();
    session.addEventListener('end', unbindXrSession);
    events.emit('vr:enter', {});
  }

  function unbindXrSession(): void {
    if (!xrSession) return;
    xrSession.removeEventListener('end', unbindXrSession);
    xrSession = null;
    input.setXrSession(null);
    if (camera.parent === xrOrigin) xrOrigin.remove(camera);
    xrOrigin.position.set(0, 0, 0);
    xrOrigin.rotation.set(0, 0, 0);
    overlay.setVrPresenting(false);
    applyViewVisibility();
    events.emit('vr:exit', {});
  }

  /** Advance the simulation. Split from rendering so a fixed tick can drive it. */
  function update(dt: number): void {
    if (dt <= 0) return;
    elapsed += dt;

    const presenting = renderer.xr.isPresenting;
    if (presenting) input.pollXr(dt);
    const look = input.readLook();
    const playing = isPlaying();
    if (playing && !presenting) {
      if (input.locked || isTouchDevice() || options.ui?.moveBeforeLock === true) {
        cameraRig.look(look.dx, look.dy);
        if (input.locked) cameraRig.zoom(look.wheel);
      }
      if (input.consume('toggleView')) setViewMode(cameraRig.nextMode());
      if (cameraRig.mode === 'aerial') {
        // The move keys and the joystick pan the bird's-eye view; the player stays put.
        const axis = input.getMoveAxis();
        cameraRig.pan(axis.x, axis.z, dt, input.isDown('sprint'));
        if (input.consumeClick() || input.consume('interact')) landFromAerial();
      }
      const digit = input.consumeDigit();
      const expression = digit === null ? null : expressionForDigit(digit);
      if (expression) player.setExpression(expression);
    }

    if (presenting) {
      xrOrigin.rotation.y += input.readXrTurn();
      xrHeading.setFromQuaternion(renderer.xr.getCamera().quaternion, 'YXZ');
      cameraRig.yaw = xrHeading.y;
    }

    // Fixed substeps keep movement stable regardless of frame rate.
    let remaining = dt;
    while (remaining > 0) {
      const step = Math.min(remaining, MAX_STEP);
      controller.step(step, cameraRig.yaw, playing && cameraRig.mode !== 'aerial');
      remaining -= step;
    }

    if (controller.position.y < controller.tuning.fallLimit) doRespawn('fell');

    if (presenting) {
      xrOrigin.position.copy(controller.position);
    } else {
      cameraRig.update(dt, controller.position, player.eyeHeight * (controller.height / height));
    }
    const footfall = player.sync(controller.position, cameraRig.yaw, controller.height, {
      dt,
      speed: Math.hypot(controller.velocity.x, controller.velocity.z),
      grounded: controller.onGround || controller.flying,
      flying: controller.flying,
      heading: Math.atan2(-controller.velocity.x, -controller.velocity.z),
    }, cameraRig.mode !== 'first');
    footsteps?.update(dt, playing ? Math.hypot(controller.velocity.x, controller.velocity.z) : 0, controller.onGround, footfall, controller.velocity.y, controller.flying);
    portals.animate(elapsed);
    landingMarker.update(cameraRig.mode === 'aerial' && !presenting ? cameraRig.landing : null, cameraRig.aerialDistance, elapsed);

    updatePortals();
    input.endFrame();

    events.emit('update', { dt, state: getState() });
  }

  /** Walking, until Esc opens the pause screen. */
  function isPlaying(): boolean {
    if (renderer.xr.isPresenting) return true;
    return !overlay.isPaused() && (input.locked || options.ui?.moveBeforeLock === true);
  }

  function updatePortals(): void {
    // From the bird's-eye view no portal is in reach: E lands the player instead.
    const aerial = cameraRig.mode === 'aerial' && !renderer.xr.isPresenting;
    const nearest = aerial ? null : portals.findActive(controller.position);

    if (nearest !== activePortal) {
      if (activePortal) events.emit('portal:exit', { portal: activePortal });
      if (nearest) events.emit('portal:enter', { portal: nearest });
      activePortal = nearest;
    }

    if (aerial) {
      const where = isTouchDevice() ? 'Tap E to land here' : 'Click or press E to land here';
      overlay.setPrompt(cameraRig.landing && isPlaying() ? where : null);
      return;
    }

    if (!nearest) {
      overlay.setPrompt(null);
      if (isPlaying() && input.consume('interact')) {
        events.emit('interact', { position: controller.position.toArray() as Vec3Tuple });
      }
      return;
    }

    if (nearest.mode === 'auto') {
      overlay.setPrompt(`Entering ${nearest.label}…`);
      activatePortal(nearest);
      return;
    }

    const isTouch = isTouchDevice();
    overlay.setPrompt(isTouch ? `Tap to enter ${nearest.label}` : `Press E to enter ${nearest.label}`);
    if (isPlaying() && input.consume('interact')) activatePortal(nearest);
  }

  function activatePortal(portal: ResolvedPortal): void {
    const url = buildTravelUrl(portal.url);
    let cancelled = false;
    events.emit('portal:activate', {
      portal,
      url,
      preventDefault: () => {
        cancelled = true;
      },
    });
    if (cancelled) return;
    input.release();
    leaveFor(url);
  }

  function setViewMode(mode: ViewMode): void {
    if (cameraRig.mode === mode) return;
    cameraRig.setMode(mode);
    if (cameraRig.mode !== mode) return;
    // The bird's-eye view is a quick look around, not a way to arrive: the next world opens walking.
    if (mode !== 'aerial') rememberView(mode);
    applyViewVisibility();
    events.emit('view:change', { mode });
  }

  /** From the bird's-eye view: put the player where it points, facing the way it looks, and walk on from there. */
  function landFromAerial(): void {
    const spot = cameraRig.landing;
    if (!spot) return;
    controller.reset(spot.clone().setY(spot.y + 0.05));
    player.facing = cameraRig.yaw;
    setViewMode(cameraRig.walkingMode);
  }

  /** In first person the avatar would fill the screen. */
  function applyViewVisibility(): void {
    // In a doorway the visitor's own body is the host's: none here.
    player.setVisible(!viewing && (cameraRig.mode !== 'first' || renderer.xr.isPresenting));
  }

  function getState(): PlayerState {
    return {
      position: controller.position.toArray() as Vec3Tuple,
      velocity: controller.velocity.toArray() as Vec3Tuple,
      yaw: cameraRig.yaw,
      pitch: cameraRig.pitch,
      facing: player.facing,
      onGround: controller.onGround,
      crouching: controller.crouching,
      flying: controller.flying,
      expression: player.expression,
    };
  }

  function setState(state: Partial<PlayerState>): void {
    if (state.position) controller.position.set(...state.position);
    if (state.velocity) controller.velocity.set(...state.velocity);
    if (typeof state.yaw === 'number') cameraRig.yaw = state.yaw;
    if (typeof state.facing === 'number') player.facing = state.facing;
    if (typeof state.pitch === 'number') cameraRig.pitch = state.pitch;
    if (typeof state.flying === 'boolean') controller.flying = state.flying;
    if (isAvatarExpression(state.expression)) player.setExpression(state.expression);
  }

  function teleport(position: Vec3Tuple, yaw?: number): void {
    controller.reset(new Vector3(...position));
    if (typeof yaw === 'number') {
      cameraRig.yaw = yaw;
      player.facing = yaw;
    }
  }

  function doRespawn(reason: 'fell' | 'manual'): void {
    controller.reset(spawn);
    events.emit('respawn', { reason });
  }

  function travelTo(url: string): void {
    input.release();
    leaveFor(buildTravelUrl(url));
  }

  function isDoorwayViewRequest(): boolean {
    try {
      return window.parent !== window && new URLSearchParams(window.location.search).has(DOORWAY_VIEW_PARAM);
    } catch {
      return false;
    }
  }

  function handleResize(): void {
    if (renderer.xr.isPresenting) return;
    const width = window.innerWidth;
    const viewHeight = window.innerHeight;
    // Pixel ratio first: setSize derives the drawing buffer from it, and it
    // must also update the canvas CSS size or the canvas overflows the window.
    renderer.setPixelRatio(viewing ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, viewHeight);
    cameraRig.resize(width, viewHeight);
  }

  function createMultiplayer(watch = false): Presence | undefined {
    if (!options.multiplayer) return undefined;
    const server = (options.multiplayer === true ? undefined : options.multiplayer.server) ?? DEFAULT_PRESENCE_SERVER;
    return new Presence({
      url: `${server.replace(/\/$/, '')}/world`,
      scene,
      watch,
      onCount: (count) => events.emit('players', { count }),
      getAvatar: () => sharedAvatar.get(),
      // Other players' avatars are shown only from links this world's hub signed.
      verifyAvatar: createShareVerifier((options.avatar?.source === 'worldmesh' && options.avatar.hubUrl) || DEFAULT_HUB),
      maxAvatarBytes: options.avatar?.maxBytes,
    });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stop();
    const session = xrSession;
    if (session) {
      session.removeEventListener('end', unbindXrSession);
      unbindXrSession();
      void session.end().catch(() => undefined);
    }
    avatarLoad?.abort();
    sharedAvatar.dispose();
    window.removeEventListener('resize', handleResize);
    network?.detach?.();
    input.dispose();
    overlay.dispose();
    portals.dispose();
    landingMarker.dispose();
    player.dispose();
    footsteps?.dispose();
    if (vrEnabled) scene.remove(xrOrigin);
    events.clear();
  }
}

/** What a host sends a live doorway view every frame (docs/specs/doorway.md §3.1). */
interface DoorwayView {
  camera: { position: Vec3Tuple; quaternion: [number, number, number, number]; fov: number };
  viewport: { width: number; height: number };
  /** The doorway on screen, [left, top, right, bottom] in CSS pixels: the only part seen. */
  rect: [number, number, number, number];
}

function validDoorwayView(view: Partial<DoorwayView>): view is DoorwayView {
  const numbers = (value: unknown, length: number) =>
    Array.isArray(value) && value.length === length && value.every((n) => typeof n === 'number' && Number.isFinite(n));
  const { camera, viewport } = view;
  return (
    !!camera &&
    numbers(camera.position, 3) &&
    numbers(camera.quaternion, 4) &&
    typeof camera.fov === 'number' &&
    camera.fov > 0 &&
    !!viewport &&
    viewport.width > 0 &&
    viewport.height > 0 &&
    numbers(view.rect, 4)
  );
}

const UP = new Vector3(0, 1, 0);
const viewSize = new Vector2();
const viewTurn = new Quaternion();
const viewQuaternion = new Quaternion();
const viewThreshold = new Vector3();
const viewForward = new Vector3();
const viewClip = new Plane();

/** On the page while it is drawn in a host's doorway: its overlay and touch controls are kept, unseen. */
const DOORWAY_VIEW_CLASS = 'wm-doorway-view';

function injectDoorwayViewStyle(): void {
  if (document.getElementById(DOORWAY_VIEW_CLASS)) return;
  const style = document.createElement('style');
  style.id = DOORWAY_VIEW_CLASS;
  style.textContent = `html.${DOORWAY_VIEW_CLASS} .wm-overlay, html.${DOORWAY_VIEW_CLASS} .wm-touch-root { display: none !important; }`;
  document.head.appendChild(style);
}
