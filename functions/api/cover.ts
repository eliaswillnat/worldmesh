/**
 * Cloudflare Pages deploys the Functions at the repository root (the hub's
 * Pages project builds from `/`), so the cover proxy has to be routed from
 * here. The implementation lives with the rest of the hub.
 */
export { onRequestGet } from '../../apps/hub/functions/api/cover';
