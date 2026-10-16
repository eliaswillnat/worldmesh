import * as THREE from 'three';
import type { WorldMeshHandle, WorldMeshOptions } from './types.js';
import { WORLDMESH_PROTOCOL, WORLDMESH_VERSION } from './version.js';

/**
 * The current runtime for this protocol, served by WorldMesh
 * (scripts/build-hosted.mjs). `loadWorldMesh` runs it, so a fix reaches a
 * world the next time it is opened, without the world rebuilding.
 */
export const HOSTED_RUNTIME_URL = `https://worldmesh.net/runtime/${WORLDMESH_PROTOCOL}/index.js`;

/** Where the hosted runtime picks up the world's own Three.js (scripts/build-hosted.mjs). */
const THREE_KEY = Symbol.for('worldmesh.three');
const DEFAULT_TIMEOUT_MS = 8000;

export interface LoadWorldMeshOptions {
  /** Run the runtime from here instead: a preview or a self-hosted copy. */
  url?: string;
  /** Give up on it after this many milliseconds and use the bundled copy. Default 8000. */
  timeoutMs?: number;
  /** false: always use the copy bundled with the world, as `createWorldMesh` does. */
  hosted?: boolean;
}

/** What the hosted runtime exports (src/hosted.ts). */
interface HostedRuntime {
  createWorldMesh(options: WorldMeshOptions): WorldMeshHandle;
  WORLDMESH_PROTOCOL: number;
  WORLDMESH_VERSION: string;
}

const loading = new Map<string, Promise<HostedRuntime | null>>();

/**
 * `createWorldMesh`, kept current: runs the latest runtime WorldMesh serves for
 * this protocol, with the world's own Three.js. If that cannot be loaded in
 * time, or does not start, the copy bundled with the world runs instead, so
 * the world works as it did when it was built.
 */
export async function loadWorldMesh(options: WorldMeshOptions, load: LoadWorldMeshOptions = {}): Promise<WorldMeshHandle> {
  const useHosted = load.hosted !== false && typeof window !== 'undefined';
  const hosted = useHosted ? await hostedRuntime(load.url ?? HOSTED_RUNTIME_URL, load.timeoutMs ?? DEFAULT_TIMEOUT_MS) : null;
  if (hosted) {
    try {
      return hosted.createWorldMesh(options);
    } catch (error) {
      console.warn(`[WorldMesh] Runtime ${hosted.WORLDMESH_VERSION} did not start; using the copy bundled with this world (${WORLDMESH_VERSION}).`, error);
    }
  }
  const { createWorldMesh } = await import('./core/worldmesh.js');
  return createWorldMesh(options);
}

function hostedRuntime(url: string, timeoutMs: number): Promise<HostedRuntime | null> {
  let pending = loading.get(url);
  if (!pending) {
    pending = importHosted(url, timeoutMs);
    loading.set(url, pending);
  }
  return pending;
}

async function importHosted(url: string, timeoutMs: number): Promise<HostedRuntime | null> {
  const shared = globalThis as unknown as Record<symbol, unknown>;
  shared[THREE_KEY] ??= THREE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const fallback = `using the copy bundled with this world (${WORLDMESH_VERSION})`;
  try {
    // Left to the browser: bundlers must not try to resolve or inline it.
    const imported = import(/* webpackIgnore: true */ /* @vite-ignore */ url) as Promise<HostedRuntime>;
    const runtime = await Promise.race([imported, timeout]);
    if (!runtime) {
      console.info(`[WorldMesh] ${url} took longer than ${timeoutMs} ms; ${fallback}.`);
      return null;
    }
    if (runtime.WORLDMESH_PROTOCOL !== WORLDMESH_PROTOCOL || typeof runtime.createWorldMesh !== 'function') {
      console.warn(`[WorldMesh] ${url} is not a protocol ${WORLDMESH_PROTOCOL} runtime; ${fallback}.`);
      return null;
    }
    return runtime;
  } catch (error) {
    console.info(`[WorldMesh] Could not load ${url}; ${fallback}.`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
