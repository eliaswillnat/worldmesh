import type { ViewMode } from '../types.js';

/**
 * Remembering the visitor's camera view (first or third person) between worlds.
 *
 * Worlds live on different origins, so storage alone cannot carry it: travel
 * URLs add it to the fragment (`#wm-view=third`), and each world also keeps it
 * in localStorage so it holds across reloads and later visits.
 *
 * Only a view the visitor picked (or was handed) is carried. Until then every
 * world opens in its own default.
 */

export const VIEW_PARAM = 'wm-view';
export const VIEW_STORAGE_KEY = 'worldmesh.view';

let current: ViewMode | null = null;

function isViewMode(value: unknown): value is ViewMode {
  return value === 'first' || value === 'third';
}

/** Moves a view from this page's URL fragment into storage, and returns the remembered one. */
export function takeViewHandoff(): ViewMode | null {
  const hash = window.location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const view = params.get(VIEW_PARAM);
    if (view !== null) {
      params.delete(VIEW_PARAM);
      const rest = params.toString();
      history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`);
      if (isViewMode(view)) rememberView(view);
    }
  }
  if (!current) {
    try {
      const stored = localStorage.getItem(VIEW_STORAGE_KEY);
      if (isViewMode(stored)) current = stored;
    } catch {
      // Storage blocked: the view still follows through travel URLs.
    }
  }
  return current;
}

export function getRememberedView(): ViewMode | null {
  return current;
}

export function rememberView(mode: ViewMode): void {
  current = mode;
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    // Storage blocked: the view still follows through travel URLs.
  }
}

/** Adds the remembered view to a destination URL's fragment, next to any other WorldMesh handoff. */
export function withView(url: URL): URL {
  if (!current || !/^https?:$/.test(url.protocol)) return url;
  const params = new URLSearchParams(url.hash.slice(1));
  params.set(VIEW_PARAM, current);
  url.hash = params.toString();
  return url;
}
