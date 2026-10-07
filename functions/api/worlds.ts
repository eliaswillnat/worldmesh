/**
 * Cloudflare Pages deploys the Functions at the repository root (the hub's
 * Pages project builds from `/`), so this route has to be exposed from here.
 * The implementation lives with the rest of the hub.
 */
export { onRequestGet, onRequestOptions } from '../../apps/hub/functions/api/worlds';
