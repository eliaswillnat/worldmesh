import type { WebGLRenderer } from 'three';

export const IMMERSIVE_VR = 'immersive-vr';

/**
 * Whether this browser can start a WebXR immersive-vr session.
 * Headset browsers resolve true; ordinary desktop Chrome resolves false.
 */
export async function immersiveVrSupported(): Promise<boolean> {
  const xr = navigator.xr;
  if (!xr?.isSessionSupported) return false;
  try {
    return await xr.isSessionSupported(IMMERSIVE_VR);
  } catch {
    return false;
  }
}

/**
 * Ask the browser for an immersive VR session and hand it to Three.js.
 * Must run from a user gesture (the Enter VR button).
 */
export async function requestImmersiveVr(renderer: WebGLRenderer): Promise<XRSession> {
  const xr = navigator.xr;
  if (!xr?.requestSession) throw new Error('WebXR is not available');
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  const session = await xr.requestSession(IMMERSIVE_VR, {
    optionalFeatures: ['local-floor', 'bounded-floor'],
  });
  await renderer.xr.setSession(session);
  return session;
}
