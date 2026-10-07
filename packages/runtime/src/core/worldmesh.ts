import { Euler, Group, Vector3 } from 'three';
import { resolveAbilities } from '../abilities/abilities.js';
import { parseAvatarDescriptor, type AvatarDescriptor } from '../avatar/descriptor.js';
import { resolveWorldMeshAvatar, takeAvatarTicket } from '../avatar/handoff.js';
import { rememberView, takeViewHandoff } from '../camera/viewHandoff.js';
import { loadAvatarModel } from '../avatar/loader.js';
import { Footsteps } from '../audio/footsteps.js';
import { CameraRig } from '../camera/cameraRig.js';
import { Input } from '../controls/input.js';
import { CollisionWorld } from '../movement/collision.js';
import { MovementController } from '../movement/controller.js';
import { expressionForDigit, isAvatarExpression } from '../player/avatar.js';
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
import { captureDoorView, type DoorViewOptions } from '../capture/doorView.js';
import { DEFAULT_PRESENCE_SERVER, Presence } from '../net/presence.js';
import { roomFullLabel } from '../net/roomFull.js';

/** Never simulate more than this per substep, so a stall cannot tunnel the player. */
const MAX_STEP = 1 / 60;
/** Never simulate more than this per frame, so a backgrounded tab does not catch up violently. */
const MAX_FRAME = 0.1;
const DEFAULT_HUB = 'https://worldmesh.net/';
/**
 * Set by WorldMesh's capture service when it opens a world to take its door
 * view. The world then stays offline, so other visitors stay out of the shot.
 */
export const CAPTURE_PARAM = 'worldmesh-capture';

/**
 * Turn an ordinary Three.js scene into a WorldMesh world.
 *
 * This is the whole compatibility surface: a world that can produce a scene,
 * a camera and a renderer gets the shared controls, both camera modes, the
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

    addPortal: (portal) => {
      portals.add(portal);
    },
    travelTo,

    loadAvatar,
    clearAvatar,

    on: (event, fn) => events.on(event, fn),
    off: (event, fn) => events.off(event, fn),

    refreshColliders: () => collision.refresh(),

    enterVR,
    exitVR,
    isVR: () => renderer.xr.isPresenting,

    captureDoorView: doCaptureDoorView,
  };

  applyViewVisibility();

  if (options.autoResize !== false) window.addEventListener('resize', handleResize);
  handleResize();

  if (options.autoStart !== false) start();

  const capturing = isCaptureRequest();
  if (capturing) exposeCapture();
  const network = capturing ? undefined : options.network ?? createMultiplayer();
  if (network instanceof Presence) {
    network.setOnFull((full) => {
      overlay.setRoomFull(full ? roomFullLabel(network.url) : null, {
        onRetry: full ? () => network.rejoin() : undefined,
      });
      if (full) input.exitPointerLock();
      events.emit('room:full', { full });
    });
  }
  network?.attach(handle);
  if (network?.bodies) controller.bodies = () => network.bodies!();

  startAvatar();
  if (vrEnabled) void offerVr();

  return handle;

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

  async function loadAvatar(descriptor: AvatarDescriptor): Promise<boolean> {
    if (disposed || !player.root) return false;
    avatarLoad?.abort();
    const load = (avatarLoad = new AbortController());
    try {
      const loaded = await loadAvatarModel(descriptor, {
        height,
        maxBytes: options.avatar?.maxBytes,
        signal: load.signal,
      });
      if (disposed || load.signal.aborted) {
        loaded.dispose();
        return false;
      }
      if (!player.setExternalBody(loaded)) return false;
      avatarDescriptor = descriptor;
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
    renderer.render(scene, camera);
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
      if (input.consume('toggleView')) setViewMode(cameraRig.mode === 'first' ? 'third' : 'first');
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
      controller.step(step, cameraRig.yaw, playing);
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
      heading: Math.atan2(-controller.velocity.x, -controller.velocity.z),
    }, cameraRig.mode === 'third');
    footsteps?.update(dt, playing ? Math.hypot(controller.velocity.x, controller.velocity.z) : 0, controller.onGround, footfall, controller.velocity.y, controller.flying);
    portals.animate(elapsed);

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
    const nearest = portals.findActive(controller.position);

    if (nearest !== activePortal) {
      if (activePortal) events.emit('portal:exit', { portal: activePortal });
      if (nearest) events.emit('portal:enter', { portal: nearest });
      activePortal = nearest;
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
    input.exitPointerLock();
    window.location.href = url;
  }

  function setViewMode(mode: ViewMode): void {
    if (cameraRig.mode === mode) return;
    cameraRig.setMode(mode);
    rememberView(mode);
    applyViewVisibility();
    events.emit('view:change', { mode });
  }

  /** In first person the avatar would fill the screen. */
  function applyViewVisibility(): void {
    player.setVisible(cameraRig.mode === 'third' || renderer.xr.isPresenting);
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
    input.exitPointerLock();
    window.location.href = buildTravelUrl(url);
  }

  /** Snapshot the view from where the player stands, the way they face, for hub doors. */
  async function doCaptureDoorView(captureOptions?: DoorViewOptions) {
    if (disposed) throw new Error('This world has been disposed.');
    if (renderer.xr.isPresenting) throw new Error('Cannot capture a door view during VR.');
    const wasRunning = running;
    stop();
    try {
      return await captureDoorView(
        {
          scene,
          renderer,
          camera: camera as { near: number; far: number },
          eye: controller.position.clone().setY(controller.position.y + player.eyeHeight * (controller.height / height)),
          yaw: cameraRig.yaw,
          hide: [player.root],
        },
        captureOptions,
      );
    } finally {
      if (wasRunning) start();
    }
  }

  function isCaptureRequest(): boolean {
    try {
      return new URLSearchParams(window.location.search).has(CAPTURE_PARAM);
    } catch {
      return false;
    }
  }

  /** The capture service drives the page from outside, so give it one global to call. */
  function exposeCapture(): void {
    (window as unknown as { __worldmeshCaptureDoorView?: typeof doCaptureDoorView }).__worldmeshCaptureDoorView = doCaptureDoorView;
  }

  function handleResize(): void {
    if (renderer.xr.isPresenting) return;
    const width = window.innerWidth;
    const viewHeight = window.innerHeight;
    // Pixel ratio first: setSize derives the drawing buffer from it, and it
    // must also update the canvas CSS size or the canvas overflows the window.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, viewHeight);
    cameraRig.resize(width, viewHeight);
  }

  function createMultiplayer(): Presence | undefined {
    if (!options.multiplayer) return undefined;
    const server = (options.multiplayer === true ? undefined : options.multiplayer.server) ?? DEFAULT_PRESENCE_SERVER;
    return new Presence({
      url: `${server.replace(/\/$/, '')}/world`,
      scene,
      onCount: (count) => events.emit('players', { count }),
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
    window.removeEventListener('resize', handleResize);
    network?.detach?.();
    input.dispose();
    overlay.dispose();
    portals.dispose();
    player.dispose();
    footsteps?.dispose();
    if (vrEnabled) scene.remove(xrOrigin);
    events.clear();
  }
}
