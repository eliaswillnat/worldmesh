export interface DoorViewEnv {
  /** workers/screenshot; defaults to the deployed one. */
  SCREENSHOT_ENDPOINT?: string;
  /** workers/screenshot's SCREENSHOT_SECRET: door views can only be requested by servers. */
  SCREENSHOT_SECRET?: string;
}

const DEFAULT_SCREENSHOT_ENDPOINT = 'https://worldmesh-screenshot.elias-willnat.workers.dev';

/**
 * Ask workers/screenshot to take a newly listed world's door view (what its
 * hub door shows up close). Best-effort: the world is listed either way, and
 * its door keeps the cover until a view exists.
 */
export async function queueDoorView(env: DoorViewEnv, worldUrl: string): Promise<void> {
  if (!env.SCREENSHOT_SECRET) return;
  const endpoint = (env.SCREENSHOT_ENDPOINT || DEFAULT_SCREENSHOT_ENDPOINT).replace(/\/$/, '');
  try {
    await fetch(`${endpoint}/door-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SCREENSHOT_SECRET}` },
      body: JSON.stringify({ url: worldUrl }),
    });
  } catch {
    // Best-effort.
  }
}
