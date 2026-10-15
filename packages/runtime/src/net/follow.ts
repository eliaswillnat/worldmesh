/**
 * Turn `yaw` toward `target` by `blend` (0 to 1) of the way, the short way
 * round. Radians; the result is not wrapped. Remote figures ease toward the
 * facing their owner last reported with this.
 */
export function easeYaw(yaw: number, target: number, blend: number): number {
  const delta = Math.atan2(Math.sin(target - yaw), Math.cos(target - yaw));
  return yaw + delta * blend;
}
