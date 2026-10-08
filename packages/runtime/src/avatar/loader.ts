import { AnimationMixer, Box3, Group, MathUtils, Mesh, Texture, type AnimationAction, type Object3D } from 'three';
import type { AvatarMotion } from '../player/avatar.js';
import type { AvatarDescriptor } from './descriptor.js';

/** A loaded external avatar, normalised to the WorldMesh body convention. */
export interface LoadedAvatar {
  /** Feet at y = 0, facing -Z, scaled to the player's height. */
  object: Object3D;
  /** Call once per frame with how the player moves. */
  animate(motion: AvatarMotion): void;
  dispose(): void;
}

export interface LoadAvatarOptions {
  /** Standing height to scale the model to, in metres. */
  height: number;
  /** Refuse models larger than this. Defaults to 40 MB. */
  maxBytes?: number;
  signal?: AbortSignal;
}

/**
 * Downloads a VRM / glTF model straight from the URL in the descriptor (the
 * avatar platform's own storage) and turns it into a player body. The loaders
 * are imported on first use, so worlds that never show an external avatar
 * never download them.
 */
export async function loadAvatarModel(descriptor: AvatarDescriptor, options: LoadAvatarOptions): Promise<LoadedAvatar> {
  // The model and the loader code arrive side by side.
  const [buffer, { GLTFLoader }, vrmModule] = await Promise.all([
    fetchModel(descriptor.modelUrl, options.maxBytes ?? 40 * 1024 * 1024, options.signal),
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    descriptor.format === 'vrm' ? import('@pixiv/three-vrm') : Promise.resolve(null),
  ]);
  const loader = new GLTFLoader();
  if (vrmModule) loader.register((parser) => new vrmModule.VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(buffer, '');

  const vrm = vrmModule ? (gltf.userData.vrm as import('@pixiv/three-vrm').VRM | undefined) : undefined;
  if (descriptor.format === 'vrm' && (!vrm || !vrmModule)) throw new Error('Not a VRM model');
  const model = vrm ? vrm.scene : gltf.scene;
  if (vrm && vrmModule) {
    vrmModule.VRMUtils.removeUnnecessaryVertices(model);
    vrmModule.VRMUtils.combineSkeletons(model);
    // VRM 0.x faces -Z; this makes it face +Z like VRM 1.0 and plain glTF.
    vrmModule.VRMUtils.rotateVRM0(vrm);
  }
  model.traverse((child) => {
    // Skinned meshes are bounded by their rest pose; animated limbs would pop out of view.
    child.frustumCulled = false;
    if ((child as Mesh).isMesh) child.castShadow = true;
  });

  // glTF and VRM face +Z; WorldMesh bodies face -Z. Scale to the player and
  // stand the feet on y = 0.
  const root = new Group();
  root.name = 'worldmesh:external-avatar';
  const turn = new Group();
  turn.rotation.y = Math.PI;
  turn.add(model);
  root.add(turn);
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  const modelHeight = box.max.y - box.min.y;
  if (!(modelHeight > 0.05 && modelHeight < 100)) throw new Error('Model has no usable size');
  const scale = options.height / modelHeight;
  turn.scale.setScalar(scale);
  turn.position.y = -box.min.y * scale;

  const animate = vrm ? vrmAnimator(vrm) : clipAnimator(model, gltf.animations);
  return {
    object: root,
    animate,
    dispose() {
      if (vrm && vrmModule) vrmModule.VRMUtils.deepDispose(model);
      else disposeTree(model);
    },
  };
}

// ── Keeping models on the device ─────────────────────────────────────────────
// A model addressed by its content hash never changes, so this browser keeps
// a copy (per site, in Cache Storage) and the next visit skips the download.
// Today that is an AT Protocol blob (at3d): getBlob?did=…&cid=…, where the CID
// is the hash. Expiring links (VRoid Hub, Sketchfab) are always downloaded.

const MODEL_CACHE = 'worldmesh-avatar-models-v1';
/** A few characters' worth: the current one and some recent switches. */
const MODEL_CACHE_ENTRIES = 3;

function isContentAddressed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/xrpc/com.atproto.sync.getBlob' && !!parsed.searchParams.get('cid');
  } catch {
    return false;
  }
}

async function fetchModel(url: string, maxBytes: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const cache = isContentAddressed(url) ? await openModelCache() : null;
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const bytes = await hit.arrayBuffer();
        if (bytes.byteLength > 0 && bytes.byteLength <= maxBytes) return bytes;
      }
    } catch {
      // A broken entry: download it again.
    }
  }
  const bytes = await download(url, maxBytes, signal);
  if (cache) void keepModel(cache, url, bytes);
  return bytes;
}

async function openModelCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(MODEL_CACHE);
  } catch {
    // Private browsing, or storage blocked.
    return null;
  }
}

async function keepModel(cache: Cache, url: string, bytes: ArrayBuffer): Promise<void> {
  try {
    await cache.put(url, new Response(bytes.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } }));
    // Oldest first: drop all but the most recent few.
    const keys = await cache.keys();
    for (const request of keys.slice(0, Math.max(0, keys.length - MODEL_CACHE_ENTRIES))) await cache.delete(request);
  } catch {
    // Out of space or storage blocked: it simply downloads next time.
  }
}

async function download(url: string, maxBytes: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
  if (!response.ok) throw new Error(`Model download failed (${response.status})`);
  if (Number(response.headers.get('Content-Length') ?? '0') > maxBytes) throw new Error('Model is too large');
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('Model is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * VRMs arrive in a T-pose with no animation. Lower the arms and swing arms
 * and legs with speed, through the normalised humanoid rig so it works for
 * any VRM, then let spring bones (hair, clothes) follow.
 */
function vrmAnimator(vrm: import('@pixiv/three-vrm').VRM): (motion: AvatarMotion) => void {
  const bone = (name: Parameters<NonNullable<typeof vrm.humanoid>['getNormalizedBoneNode']>[0]) =>
    vrm.humanoid?.getNormalizedBoneNode(name) ?? null;
  const armL = bone('leftUpperArm');
  const armR = bone('rightUpperArm');
  const foreArmL = bone('leftLowerArm');
  const foreArmR = bone('rightLowerArm');
  const legL = bone('leftUpperLeg');
  const legR = bone('rightUpperLeg');
  const kneeL = bone('leftLowerLeg');
  const kneeR = bone('rightLowerLeg');
  // VRM 0.x rigs are mirrored on X and Z relative to VRM 1.0.
  const mirror = vrm.meta?.metaVersion === '0' ? -1 : 1;
  let phase = 0;
  let stride = 0;
  let air = 0;

  return (motion) => {
    if (motion.dt <= 0) return;
    const blend = 1 - Math.exp(-motion.dt * 10);
    const walking = motion.grounded ? MathUtils.clamp(motion.speed / 4.5, 0, 1) : 0;
    stride += (walking - stride) * blend;
    air += ((motion.grounded ? 0 : 1) - air) * blend;
    phase += motion.dt * (4 + motion.speed * 1.2) * (stride > 0.01 ? 1 : 0);
    const swing = Math.sin(phase) * 0.6 * stride;

    const armDown = 1.2 - air * 0.5;
    if (armL) armL.rotation.set(mirror * swing * 0.7, 0, mirror * -armDown);
    if (armR) armR.rotation.set(mirror * -swing * 0.7, 0, mirror * armDown);
    if (foreArmL) foreArmL.rotation.set(0, 0, mirror * -0.15);
    if (foreArmR) foreArmR.rotation.set(0, 0, mirror * 0.15);
    if (legL) legL.rotation.set(mirror * (-swing - air * 0.3), 0, 0);
    if (legR) legR.rotation.set(mirror * (swing - air * 0.1), 0, 0);
    if (kneeL) kneeL.rotation.set(mirror * (Math.max(0, swing) * 0.8 + air * 0.4), 0, 0);
    if (kneeR) kneeR.rotation.set(mirror * (Math.max(0, -swing) * 0.8 + air * 0.2), 0, 0);
    vrm.update(motion.dt);
  };
}

/** Plain glTF bodies: play an idle clip, and a walk/run clip while moving, if the file has them. */
function clipAnimator(model: Object3D, clips: import('three').AnimationClip[]): (motion: AvatarMotion) => void {
  if (!clips.length) return () => {};
  const mixer = new AnimationMixer(model);
  const find = (pattern: RegExp) => clips.find((clip) => pattern.test(clip.name));
  const idleClip = find(/idle|stand|breath/i) ?? clips[0];
  const walkClip = find(/walk|run|jog/i);
  const idle = mixer.clipAction(idleClip).play();
  const walk: AnimationAction | null = walkClip && walkClip !== idleClip ? mixer.clipAction(walkClip) : null;
  let moving = false;
  return (motion) => {
    const nowMoving = motion.grounded && motion.speed > 0.5;
    if (walk && nowMoving !== moving) {
      moving = nowMoving;
      const [from, to] = moving ? [idle, walk] : [walk, idle];
      to.reset().play();
      from.crossFadeTo(to, 0.2, false);
    }
    mixer.update(motion.dt);
  };
}

function disposeTree(root: Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry.dispose();
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) value.dispose();
      }
      material.dispose();
    }
  });
}
