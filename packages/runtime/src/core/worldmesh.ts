import { Euler, Group, PerspectiveCamera, Vector3 } from 'three';
import { resolveAbilities } from '../abilities/abilities.js';
import { parseAvatarDescriptor, type AvatarDescriptor } from '../avatar/descriptor.js';
import { resolveWorldMeshAvatar, setAvatarTicket, takeAvatarTicket } from '../avatar/handoff.js';
import { rememberView, takeViewHandoff } from '../camera/viewHandoff.js';
import { loadAvatarModel } from '../avatar/loader.js';
import { Footsteps } from '../audio/footsteps.js';
import { CameraRig } from '../camera/cameraRig.js';
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
import { captureDoorView, type DoorViewOptions } from '../capture/doorView.js';
import { exportPortal, type PortalSceneOptions } from '../capture/portalScene.js';
import { DEFAULT_PRESENCE_SERVER, Presence } from '../net/presence.js';
import { roomFullLabel } from '../net/roomFull.js';

/** Never simulate more than this per substep, so a stall cannot tunnel the player. */
const MAX_STEP = 1 / 60;
/** Never simulate more than this per frame, so a backgrounded tab does not catch up violently. */
const MAX_FRAME = 0.1;
const DEFAULT_HUB = 'https://worldmesh.net/';
/** An embedded world waiting to be walked into draws this rarely: enough to stay warm, little enough to leave the hub its frames. */
const DORMANT_FRAME_MS = 250;
/** Seconds to ease the field of view back to the world's own after taking over the hub's camera. */
const FOV_RETURN = 1.5;
/**
 * Set by WorldMesh's capture service when it opens a world to take its door
 * view. The world then stays offline, so other visitors stay out of the shot.
 */
export const CAPTURE_PARAM = 'worldmesh-capture';
/**
 * Set by a hub that shows the world live in one of its doors. The world
 * waits offline until the hub posts `{ type: 'worldmesh:enter' }` (the
 * visitor walked through the door), then goes online without reloading.
 * While embedded, it asks the hub to take the visitor anywhere else
 * (`{ type: 'worldmesh:navigate', url }`), as the page around it is the hub's.
 */
export const EMBED_PARAM = 'worldmesh-embed';

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
    getCameraDistance: () => cameraRig.distance,
    setCameraDistance: (distance) => {
      if (Number.isFinite(distance)) cameraRig.distance = Math.max(0.4, distance);
    },

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
    exportPortal: doExportPortal,
  };

  applyViewVisibility();

  if (options.autoResize !== false) window.addEventListener('resize', handleResize);
  handleResize();

  if (options.autoStart !== false) start();

  const capturing = isCaptureRequest();
  const embedded = !capturing && isEmbedRequest();
  let network: WorldMeshOptions['network'];
  /** Embedded and not walked into yet. */
  let dormant = embedded;
  /** Easing the field of view back to the world's own, after a walk-in took over the hub's. */
  let fovReturn: { from: number; to: number; t: number } | null = null;
  if (capturing) exposeCapture();
  if (embedded) awaitEntry();
  else if (!capturing) goOnline();

  startAvatar();
  if (vrEnabled) void offerVr();

  return handle;

  function goOnline(): void {
    network = options.network ?? createMultiplayer();
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
    network?.attach(handle);
    const bodies = network?.bodies?.bind(network);
    if (bodies) controller.bodies = () => bodies();
  }

  /**
   * Shown live in a hub's door: stay offline, drawing only now and then,
   * until the visitor walks through it. The hub's travel URL (its `from`, for
   * the way back) replaces this page's own address, as if they had arrived
   * through it. A `pose` (in this world's coordinates) puts the player and
   * camera exactly where the hub had them, so the hand-over can't be seen;
   * the hub hears `worldmesh:entered` once a frame from there is drawn.
   */
  function awaitEntry(): void {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== 'worldmesh:enter') return;
      window.removeEventListener('message', onMessage);
      const url = typeof event.data.url === 'string' ? event.data.url : null;
      try {
        if (url && new URL(url).origin === window.location.origin) window.history.replaceState(null, '', url);
      } catch {
        // Keep the embed address.
      }
      if (disposed) return;
      takePose(event.data.pose);
      dormant = false;
      // Walked in: playing at once, no "click to play" in between (the cursor still needs a click to look around).
      input.requestPointerLock(isTouchDevice());
      window.addEventListener('message', onCarry);
      goOnline();
      // Two frames on, the first one from the new pose has been drawn.
      requestAnimationFrame(() => requestAnimationFrame(() => window.parent.postMessage({ type: 'worldmesh:entered' }, '*')));
    };
    // The hub's joystick, still held as the visitor walked in, keeps them walking until it is let go.
    const onCarry = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== 'worldmesh:carry') return;
      input.carry(Number(event.data.x) || 0, Number(event.data.z) || 0);
      if (!event.data.x && !event.data.z) window.removeEventListener('message', onCarry);
    };
    window.addEventListener('message', onMessage);
    awaitCharacter();
    // Nothing secret: only tells the hub this world can be walked into.
    window.parent.postMessage({ type: 'worldmesh:ready' }, '*');
  }

  /**
   * Embedded: the hub hands over the visitor's character (Avatar Wallet) while
   * the world still waits, so it is on screen from the first frame they walk
   * in: its descriptor, the model file the hub already downloaded (nothing is
   * fetched twice), and the handoff ticket for portals onwards. Taken only
   * from this world's own hub (`avatar.hubUrl`), and only if the world shows
   * Avatar Wallet characters at all. Answers `worldmesh:avatar-ready`.
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
      if (event.source !== window.parent || event.origin !== hubOrigin || event.data?.type !== 'worldmesh:avatar') return;
      const turn = ++latest;
      const { descriptor: raw, data, ticket } = event.data as { descriptor?: unknown; data?: unknown; ticket?: unknown };
      if (typeof ticket === 'string') setAvatarTicket(ticket);
      let loaded = false;
      const descriptor = parseAvatarDescriptor(raw);
      if (descriptor) {
        loaded = await loadAvatar(descriptor, data instanceof ArrayBuffer ? data : undefined);
      } else if (raw === null) {
        // Back to the default body (private mode, or no character any more).
        clearAvatar();
      }
      if (turn === latest && !disposed) window.parent.postMessage({ type: 'worldmesh:avatar-ready', loaded }, hubOrigin);
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

  /** Leave for another page; an embedded world asks its hub to go there instead. */
  function leaveFor(url: string): void {
    if (embedded) window.parent.postMessage({ type: 'worldmesh:navigate', url }, '*');
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
    if (dormant && now - lastTime < DORMANT_FRAME_MS) return;
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
    leaveFor(url);
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
    leaveFor(buildTravelUrl(url));
  }

  /** Where captures for hub doors are taken from: the player's eyes, the way they face. */
  function captureTarget() {
    return {
      scene,
      renderer,
      camera: camera as { near: number; far: number },
      eye: controller.position.clone().setY(controller.position.y + player.eyeHeight * (controller.height / height)),
      yaw: cameraRig.yaw,
      hide: [player.root],
    };
  }

  /** Captures resize the canvas and draw on their own, so the world's loop pauses meanwhile. */
  async function whilePaused<T>(what: string, run: () => Promise<T>): Promise<T> {
    if (disposed) throw new Error('This world has been disposed.');
    if (renderer.xr.isPresenting) throw new Error(`Cannot ${what} during VR.`);
    const wasRunning = running;
    stop();
    try {
      return await run();
    } finally {
      if (wasRunning) start();
    }
  }

  /** Snapshot the view from where the player stands, the way they face, for hub doors. */
  function doCaptureDoorView(captureOptions?: DoorViewOptions) {
    return whilePaused('capture a door view', () => captureDoorView(captureTarget(), captureOptions));
  }

  /** The scene around where the player stands, for hub doors to draw live. */
  function doExportPortal(portalOptions?: PortalSceneOptions) {
    return whilePaused('export a portal scene', () =>
      exportPortal({ ...captureTarget(), feet: controller.position.clone() }, portalOptions),
    );
  }

  function isEmbedRequest(): boolean {
    try {
      return window.parent !== window && new URLSearchParams(window.location.search).has(EMBED_PARAM);
    } catch {
      return false;
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
    const hooks = window as unknown as {
      __worldmeshCaptureDoorView?: typeof doCaptureDoorView;
      __worldmeshExportPortal?: typeof doExportPortal;
    };
    hooks.__worldmeshCaptureDoorView = doCaptureDoorView;
    hooks.__worldmeshExportPortal = doExportPortal;
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
